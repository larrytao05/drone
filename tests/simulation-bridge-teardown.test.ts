import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  SimulationBridgeSession,
} from "../web/server/simulation-bridge.js";

type MockChild = ChildProcess & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createMockChildProcess(): {
  child: ChildProcess;
  stdinStream: PassThrough;
  stdoutStream: PassThrough;
  stderrStream: PassThrough;
} {
  const emitter = new EventEmitter();
  const stdinStream = new PassThrough();
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  const child = Object.assign(emitter, {
    stdin: stdinStream,
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: (signal?: string) => {
      setImmediate(() => emitter.emit("close", signal === "SIGKILL" ? 137 : 0));
      return true;
    },
  }) as unknown as MockChild;

  stdinStream.on("data", (chunk: Buffer) => {
    try {
      const parsed = JSON.parse(chunk.toString("utf-8").trim());
      if (parsed.command === "end") {
        setImmediate(() => emitter.emit("close", 0));
      }
    } catch {
      // ignore
    }
  });

  return { child, stdinStream, stdoutStream, stderrStream };
}

describe("simulation-bridge teardown coordination", () => {
  it("joins concurrent end calls into a single teardown operation and writes end to stdin once", async () => {
    const { child, stdinStream } = createMockChildProcess();
    const stdinWrites: string[] = [];
    stdinStream.on("data", (chunk: Buffer) => {
      stdinWrites.push(chunk.toString("utf-8"));
    });

    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => true,
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    const [end1, end2] = await Promise.all([
      session.end(runId),
      session.end(runId),
    ]);

    expect(end1.ok).toBe(true);
    expect(end1.statusCode).toBe(200);
    expect(end1.status.phase).toBe("ended");

    expect(end2.ok).toBe(true);
    expect(end2.statusCode).toBe(200);
    expect(end2.status.phase).toBe("ended");

    const endCommands = stdinWrites
      .map((w) => {
        try {
          return JSON.parse(w.trim());
        } catch {
          return null;
        }
      })
      .filter((c) => c?.command === "end");
    expect(endCommands.length).toBe(1);
  });

  it("joins unexpected child close and concurrent explicit end into a single teardown operation with exactly one cleanup call", async () => {
    const { child } = createMockChildProcess();
    let cleanupCalls = 0;
    let releaseCleanup!: () => void;
    const cleanupDeferred = new Promise<boolean>((resolve) => {
      releaseCleanup = () => resolve(true);
    });

    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => {
        cleanupCalls++;
        return await cleanupDeferred;
      },
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    // 1. Child unexpectedly emits close
    child.emit("close", 0);

    // 2. Before deferred cleanup releases, operator calls session.end(runId)
    const endPromise = session.end(runId);

    // Snapshot while in-flight shows teardown in progress (ending), not early ended
    const midSnap = session.getSnapshot();
    expect(midSnap.status.phase).toBe("ending");

    // 3. Release cleanup
    releaseCleanup();
    const endRes = await endPromise;

    expect(endRes.ok).toBe(true);
    expect(endRes.statusCode).toBe(200);
    expect(endRes.status.phase).toBe("ended");
    expect(endRes.status.error).toBeNull();

    // Invariant: exactly ONE cleanupContainers call occurred, not two!
    expect(cleanupCalls).toBe(1);

    // Subsequent start is admitted
    const nextStart = await session.start();
    expect(nextStart.ok).toBe(true);
  });

  it("joins automatic fatal trigger and concurrent explicit end, ensuring single cleanup and preserving original failure", async () => {
    const { child } = createMockChildProcess();
    let cleanupCalls = 0;
    let releaseCleanup!: () => void;
    const cleanupDeferred = new Promise<boolean>((resolve) => {
      releaseCleanup = () => resolve(true);
    });

    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => {
        cleanupCalls++;
        return await cleanupDeferred;
      },
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    // 1. Runner emits fatal safety violation error event
    session.handleRunnerMessage({
      type: "error",
      code: "SAFETY_VIOLATION",
      message: "Flight corridor violated",
    });

    expect(session.getSnapshot().status.phase).toBe("failed");
    expect(session.getSnapshot().status.error?.code).toBe("SAFETY_VIOLATION");

    // 2. While cleanup is in-flight, operator calls session.end(runId)
    const endPromise = session.end(runId);

    // 3. Release cleanup
    releaseCleanup();
    const endRes = await endPromise;

    // Teardown finished, but original failure must be preserved (no early terminal success!)
    expect(endRes.status.phase).toBe("failed");
    expect(endRes.status.error?.code).toBe("SAFETY_VIOLATION");
    expect(endRes.status.error?.message).toBe("Flight corridor violated");

    // Snapshot also preserves meaningful failure, not "ended"
    const finalSnap = session.getSnapshot();
    expect(finalSnap.status.phase).toBe("failed");
    expect(finalSnap.status.error?.code).toBe("SAFETY_VIOLATION");

    // Invariant: exactly ONE cleanupContainers call occurred!
    expect(cleanupCalls).toBe(1);

    // Verified cleanup succeeded, so resources are free and next start is admitted
    const nextStart = await session.start();
    expect(nextStart.ok).toBe(true);
    expect(nextStart.status.phase).toBe("starting");
  });

  it("preserves unexpected child crash exit code after automatic cleanup and joins concurrent end", async () => {
    const { child } = createMockChildProcess();
    let cleanupCalls = 0;
    let releaseCleanup!: () => void;
    const cleanupDeferred = new Promise<boolean>((resolve) => {
      releaseCleanup = () => resolve(true);
    });

    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => {
        cleanupCalls++;
        return await cleanupDeferred;
      },
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    // Unexpected runner crash with exit code 1
    child.emit("close", 1);

    // Concurrent End call while cleanup is pending
    const endPromise = session.end(runId);

    releaseCleanup();
    const endRes = await endPromise;

    // Must preserve original exit code failure, not early terminal ended
    expect(endRes.status.phase).toBe("failed");
    expect(endRes.status.error?.code).toBe("SIMULATOR_ERROR");
    expect(endRes.status.error?.exitCode).toBe(1);
    expect(cleanupCalls).toBe(1);

    const snap = session.getSnapshot();
    expect(snap.status.phase).toBe("failed");
    expect(snap.status.error?.exitCode).toBe(1);
  });

  it("reports an unexpected signal exit as a runner failure after cleanup", async () => {
    const { child } = createMockChildProcess();
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => true,
    });
    const started = await session.start();
    expect(started.status.fresh).toBe(false);
    child.emit("close", null, "SIGKILL");

    const result = await session.end(started.status.runId!);
    expect(result.status.phase).toBe("failed");
    expect(result.status.error).toEqual({
      code: "SIMULATOR_ERROR",
      message: "Simulation runner terminated by signal SIGKILL",
    });
  });

  it("handles asynchronous spawn errors and preserves the failure after child close", async () => {
    const { child } = createMockChildProcess();
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => true,
    });
    const started = await session.start();
    child.emit("error", new Error("spawn python3 ENOENT"));
    child.emit("close", -2);

    const result = await session.end(started.status.runId!);
    expect(result.status.phase).toBe("failed");
    expect(result.status.error?.message).toContain("spawn python3 ENOENT");
  });

  it("does not wait on exitCode in lieu of observed close if stdio may still be open, and fails hard deadline with ownership retained", async () => {
    const emitter = new EventEmitter();
    const stdinStream = new PassThrough();
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    const childWithExitCode = Object.assign(emitter, {
      stdin: stdinStream,
      stdout: stdoutStream,
      stderr: stderrStream,
      exitCode: 0,
      kill: () => true,
    }) as unknown as ChildProcess;

    const session = new SimulationBridgeSession({
      spawnRunner: () => childWithExitCode,
      cleanupContainers: async () => true,
      teardownTimeouts: { termMs: 10, killMs: 10, hardDeadlineMs: 10 },
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    const endRes = await session.end(runId);

    expect(endRes.ok).toBe(false);
    expect(endRes.statusCode).toBe(500);
    expect(endRes.error?.code).toBe("SIMULATOR_ERROR");
    expect(endRes.error?.message).toContain("within bounded deadline");

    const startRetry = await session.start();
    expect(startRetry.ok).toBe(false);
    expect(startRetry.statusCode).toBe(409);
    expect(startRetry.error?.code).toBe("ALREADY_RUNNING");
  });

  it("lets editor distinguish teardown in progress (ending) from verified cleanup (ended)", async () => {
    const { child } = createMockChildProcess();
    let releaseCleanup!: () => void;
    const cleanupDeferred = new Promise<boolean>((resolve) => {
      releaseCleanup = () => resolve(true);
    });

    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => await cleanupDeferred,
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    const endPromise = session.end(runId);

    const inProgressSnap = session.getSnapshot();
    expect(inProgressSnap.status.phase).toBe("ending");
    expect(inProgressSnap.status.phase).not.toBe("ended");

    releaseCleanup();
    const endRes = await endPromise;

    expect(endRes.status.phase).toBe("ended");
    const verifiedSnap = session.getSnapshot();
    expect(verifiedSnap.status.phase).toBe("ended");
  });

  it("retains ownership on unexpected runner close with cleanup failure and allows retry", async () => {
    const { child } = createMockChildProcess();
    let cleanupShouldFail = true;

    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => !cleanupShouldFail,
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 20));

    const snap = session.getSnapshot();
    expect(snap.status.phase).toBe("failed");
    expect(snap.status.error?.code).toBe("CLEANUP_FAILURE");

    const startRetry = await session.start();
    expect(startRetry.ok).toBe(false);
    expect(startRetry.statusCode).toBe(409);
    expect(startRetry.error?.code).toBe("ALREADY_RUNNING");

    const resumeRetry = await session.resume(runId);
    expect(resumeRetry.ok).toBe(false);

    cleanupShouldFail = false;
    const retryEnd = await session.end(runId);
    expect(retryEnd.ok).toBe(true);
    expect(retryEnd.statusCode).toBe(200);
    expect(retryEnd.status.phase).toBe("ended");
    expect(retryEnd.status.error).toBeNull();

    const allowedStart = await session.start();
    expect(allowedStart.ok).toBe(true);
    expect(allowedStart.status.phase).toBe("starting");
  });

  it("bounds wait and fails explicitly when child ignores kill signals and does not close", async () => {
    const emitter = new EventEmitter();
    const stdinStream = new PassThrough();
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    const stubbornChild = Object.assign(emitter, {
      stdin: stdinStream,
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: () => true,
    }) as unknown as ChildProcess;

    const session = new SimulationBridgeSession({
      spawnRunner: () => stubbornChild,
      cleanupContainers: async () => true,
      teardownTimeouts: { termMs: 20, killMs: 20, hardDeadlineMs: 20 },
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    const endRes = await session.end(runId);
    expect(endRes.ok).toBe(false);
    expect(endRes.statusCode).toBe(500);
    expect(endRes.error?.code).toBe("SIMULATOR_ERROR");
    expect(endRes.error?.message).toContain("within bounded deadline");
    expect(session.getSnapshot().status.phase).toBe("failed");

    const startRetry = await session.start();
    expect(startRetry.ok).toBe(false);
    expect(startRetry.statusCode).toBe(409);
  });

  it("preassigns deterministic run container names before spawn and cleans only owned resources on early cancellation", async () => {
    let cleanedContainers: readonly string[] = [];
    const { child } = createMockChildProcess();
    let spawnedRunId: string | undefined;

    const session = new SimulationBridgeSession({
      spawnRunner: (_cmd, args) => {
        const runIdIdx = args.indexOf("--run-id");
        if (runIdIdx !== -1) {
          spawnedRunId = args[runIdIdx + 1];
        }
        return child;
      },
      cleanupContainers: async (containers) => {
        cleanedContainers = [...containers];
        return true;
      },
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;
    expect(spawnedRunId).toBe(runId);

    const endRes = await session.end(runId);
    expect(endRes.ok).toBe(true);

    expect(cleanedContainers).toContain(`sim1_${runId}_px4`);
    expect(cleanedContainers).toContain(`sim1_${runId}_client`);
    expect(cleanedContainers.length).toBe(2);
  });

  it("ignores buffered runner phases while teardown is pending", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    let finishCleanup: (success: boolean) => void = () => {};
    const cleanup = new Promise<boolean>((resolve) => { finishCleanup = resolve; });
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: () => cleanup,
    });
    const started = await session.start();
    const ending = session.end(started.status.runId!);
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "running" }) + "\n");
    expect(session.getSnapshot().status.phase).toBe("ending");
    finishCleanup(true);
    expect((await ending).status.phase).toBe("ended");
  });

  it("authoritatively exposes cleanupCompleted across run lifecycle and cleanup failures", async () => {
    const { child } = createMockChildProcess();
    let cleanupShouldSucceed = false;
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      cleanupContainers: async () => cleanupShouldSucceed,
    });

    const initial = session.getSnapshot();
    expect(initial.status.phase).toBe("ready");
    expect(initial.status.cleanupCompleted).toBe(true);

    const started = await session.start();
    const runId = started.status.runId!;
    expect(started.status.cleanupCompleted).toBe(false);
    expect(session.getSnapshot().status.cleanupCompleted).toBe(false);

    const failedEnd = await session.end(runId);
    expect(failedEnd.status.phase).toBe("failed");
    expect(failedEnd.status.cleanupCompleted).toBe(false);
    expect(failedEnd.status.error?.code).toBe("CLEANUP_FAILURE");

    cleanupShouldSucceed = true;
    const retryEnd = await session.end(runId);
    expect(retryEnd.status.cleanupCompleted).toBe(true);
    expect(session.getSnapshot().status.cleanupCompleted).toBe(true);
  });
});
