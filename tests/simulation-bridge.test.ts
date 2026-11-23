import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  SimulationBridgeSession,
  type SpawnRunner,
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

describe("simulation-bridge", () => {
  it("initializes with ready status", () => {
    const session = new SimulationBridgeSession();
    const result = session.getSnapshot();
    expect(result.ok).toBe(true);
    expect(result.status.phase).toBe("ready");
    expect(result.status.runId).toBeNull();
    expect(result.status.blocked).toBe(false);
    expect(result.status.holdRequested).toBe(false);
    expect(result.status.holdConfirmed).toBe(false);
  });

  it("starts a simulation run and rejects duplicate starts", async () => {
    const { child } = createMockChildProcess();
    const mockSpawn: SpawnRunner = () => child;

    const session = new SimulationBridgeSession({ spawnRunner: mockSpawn });
    const startResult = await session.start();
    expect(startResult.ok).toBe(true);
    expect(startResult.statusCode).toBe(200);
    expect(startResult.status.phase).toBe("starting");
    expect(startResult.status.runId).toMatch(/^sim_/);
    expect(startResult.status.events.length).toBeGreaterThan(0);

    // Duplicate start while active
    const duplicateResult = await session.start();
    expect(duplicateResult.ok).toBe(false);
    expect(duplicateResult.statusCode).toBe(409);
    expect(duplicateResult.error?.code).toBe("ALREADY_RUNNING");
  });

  it("updates telemetry and maintains monotonic sequence numbers", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    const mockSpawn: SpawnRunner = () => child;

    let currentTime = 1_000_000;
    const session = new SimulationBridgeSession({
      spawnRunner: mockSpawn,
      now: () => currentTime,
    });

    await session.start();
    const seq0 = session.getSnapshot().status.seq;

    // Simulate telemetry output from runner
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        timestamp: new Date(currentTime).toISOString(),
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 3.5,
        north_speed_m_s: 3.5,
        north_progress_m: 6.2,
      }) + "\n"
    );

    const snap1 = session.getSnapshot();
    expect(snap1.status.seq).toBeGreaterThan(seq0);
    expect(snap1.status.telemetry?.position.northProgressM).toBe(6.2);
    expect(snap1.status.telemetry?.velocity.speedMs).toBe(3.5);
    expect(snap1.status.fresh).toBe(true);

    // Advance time beyond 2000ms limit -> telemetry becomes stale
    currentTime += 2500;
    const snapStale = session.getSnapshot();
    expect(snapStale.status.fresh).toBe(false);
    expect(snapStale.status.telemetry?.sampleAgeMs).toBe(2500);
  });

  it("distinguishes hold requested from hold confirmed", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    const session = new SimulationBridgeSession({ spawnRunner: () => child });
    await session.start();

    // 1. Next segment blocked & Hold requested
    stdoutStream.write(
      JSON.stringify({ type: "blockage", blocked: true, boundary_m: 20.0 }) + "\n"
    );
    stdoutStream.write(
      JSON.stringify({ type: "hold_requested", hold_requested: true }) + "\n"
    );

    const snap1 = session.getSnapshot();
    expect(snap1.status.blocked).toBe(true);
    expect(snap1.status.holdRequested).toBe(true);
    expect(snap1.status.holdConfirmed).toBe(false);
    expect(snap1.status.phase).toBe("starting");

    // 2. Telemetry confirms hold
    stdoutStream.write(
      JSON.stringify({ type: "hold_confirmed", hold_confirmed: true }) + "\n"
    );
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "holding" }) + "\n");

    const snap2 = session.getSnapshot();
    expect(snap2.status.holdRequested).toBe(true);
    expect(snap2.status.holdConfirmed).toBe(true);
    expect(snap2.status.phase).toBe("holding");
  });

  it("enforces resume preconditions: rejects wrong run, not holding, blocked, and stale telemetry", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    let currentTime = 2_000_000;
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      now: () => currentTime,
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    // 1. Wrong runId
    const wrongRunRes = await session.resume("sim_wrong_id");
    expect(wrongRunRes.ok).toBe(false);
    expect(wrongRunRes.statusCode).toBe(400);
    expect(wrongRunRes.error?.code).toBe("WRONG_RUN");

    // 2. Not holding
    const notHoldingRes = await session.resume(runId);
    expect(notHoldingRes.ok).toBe(false);
    expect(notHoldingRes.statusCode).toBe(400);
    expect(notHoldingRes.error?.code).toBe("NOT_HOLDING");

    // Enter hold state, but keep blocked
    stdoutStream.write(
      JSON.stringify({ type: "blockage", blocked: true }) + "\n"
    );
    stdoutStream.write(
      JSON.stringify({ type: "hold_confirmed", hold_confirmed: true }) + "\n"
    );
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "holding" }) + "\n");

    // Feed fresh telemetry
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        timestamp: new Date(currentTime).toISOString(),
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 0.1,
        north_speed_m_s: 0.0,
        north_progress_m: 8.0,
      }) + "\n"
    );

    // 3. Segment blocked
    const blockedRes = await session.resume(runId);
    expect(blockedRes.ok).toBe(false);
    expect(blockedRes.statusCode).toBe(400);
    expect(blockedRes.error?.code).toBe("SEGMENT_BLOCKED");

    // Clear blockage via canonical runner event
    stdoutStream.write(
      JSON.stringify({ type: "blockage", blocked: false }) + "\n"
    );
    expect(session.getSnapshot().status.blocked).toBe(false);

    // 4. Stale telemetry
    currentTime += 3000; // age exceeds 2000ms
    const staleRes = await session.resume(runId);
    expect(staleRes.ok).toBe(false);
    expect(staleRes.statusCode).toBe(400);
    expect(staleRes.error?.code).toBe("STALE_TELEMETRY");

    // Feed fresh telemetry again
    currentTime += 100;
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        timestamp: new Date(currentTime).toISOString(),
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 0.1,
        north_speed_m_s: 0.0,
        north_progress_m: 8.0,
      }) + "\n"
    );

    // 5. Valid explicit resume
    const validResumeRes = await session.resume(runId);
    expect(validResumeRes.ok).toBe(true);
    expect(validResumeRes.statusCode).toBe(200);
  });

  it("prevents duplicate in-flight resume commands", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    const session = new SimulationBridgeSession({ spawnRunner: () => child });
    const startRes = await session.start();
    const runId = startRes.status.runId!;

    stdoutStream.write(JSON.stringify({ type: "hold_confirmed", hold_confirmed: true }) + "\n");
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "holding" }) + "\n");
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 0.0,
        north_speed_m_s: 0.0,
        north_progress_m: 8.0,
      }) + "\n"
    );

    // First resume accepted
    const res1 = await session.resume(runId);
    expect(res1.ok).toBe(true);

    // Second resume while in-flight is rejected
    const res2 = await session.resume(runId);
    expect(res2.ok).toBe(false);
    expect(res2.statusCode).toBe(409);
    expect(res2.error?.code).toBe("INVALID_REQUEST");
  });

  it("verifies writable transport on resume and handles errors", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    const session = new SimulationBridgeSession({ spawnRunner: () => child });
    const startRes = await session.start();
    const runId = startRes.status.runId!;

    stdoutStream.write(JSON.stringify({ type: "hold_confirmed", hold_confirmed: true }) + "\n");
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "holding" }) + "\n");
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 0.0,
        north_speed_m_s: 0.0,
        north_progress_m: 8.0,
      }) + "\n"
    );

    // Destroy child stdin
    child.stdin?.destroy();

    const resumeRes = await session.resume(runId);
    expect(resumeRes.ok).toBe(false);
    expect(resumeRes.statusCode).toBe(500);
    expect(resumeRes.error?.code).toBe("SIMULATOR_ERROR");
    expect(resumeRes.error?.message).toContain("not writable");
  });

  it("clears hold flags on motion confirmation", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    const session = new SimulationBridgeSession({ spawnRunner: () => child });
    const startRes = await session.start();
    const runId = startRes.status.runId!;

    stdoutStream.write(JSON.stringify({ type: "hold_requested", hold_requested: true }) + "\n");
    stdoutStream.write(JSON.stringify({ type: "hold_confirmed", hold_confirmed: true }) + "\n");
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "holding" }) + "\n");
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 0.0,
        north_speed_m_s: 0.0,
        north_progress_m: 8.0,
      }) + "\n"
    );

    const holdSnap = session.getSnapshot();
    expect(holdSnap.status.holdRequested).toBe(true);
    expect(holdSnap.status.holdConfirmed).toBe(true);

    await session.resume(runId);

    // Runner observes motion and emits running phase + route motion resumed event
    stdoutStream.write(JSON.stringify({ type: "event", label: "Route motion resumed" }) + "\n");
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "running" }) + "\n");

    const runningSnap = session.getSnapshot();
    expect(runningSnap.status.phase).toBe("running");
    expect(runningSnap.status.holdRequested).toBe(false);
    expect(runningSnap.status.holdConfirmed).toBe(false);
  });

  it("rejects malformed telemetry without fabricating zero coordinates and preserves fresh sample", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    let currentTime = 1_000_000;
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      now: () => currentTime,
    });
    await session.start();

    // 1. Valid telemetry sample
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        timestamp: "2026-11-23T00:00:00.000Z",
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 2.0,
        north_speed_m_s: 2.0,
        north_progress_m: 5.0,
      }) + "\n"
    );

    const snap1 = session.getSnapshot();
    expect(snap1.status.telemetry?.position.lat).toBe(47.397743);
    expect(snap1.status.telemetry?.position.northProgressM).toBe(5.0);

    // 2. Malformed telemetry sample (missing lat, invalid types)
    currentTime += 1000;
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        // missing lat
        lon: "not_a_number",
        alt_m: null,
      }) + "\n"
    );

    const snap2 = session.getSnapshot();
    // Must NOT have fabricated 0 coordinates!
    expect(snap2.status.telemetry?.position.lat).toBe(47.397743);
    expect(snap2.status.telemetry?.position.lon).toBe(8.545594);
    expect(snap2.status.telemetry?.position.northProgressM).toBe(5.0);
    // Preserved last valid sample, aging honestly
    expect(snap2.status.telemetry?.sampleAgeMs).toBe(1000);
  });

  it("strictly validates runner messages with Zod schemas", () => {
    const session = new SimulationBridgeSession();

    // Invalid phase enum value
    session.handleRunnerMessage({ type: "phase", phase: "invalid_unrecognized_phase" });
    expect(session.getSnapshot().status.phase).toBe("ready");

    // Valid phase
    session.handleRunnerMessage({ type: "phase", phase: "running" });
    expect(session.getSnapshot().status.phase).toBe("running");

    // Invalid error code defaults safely
    session.handleRunnerMessage({ type: "error", code: "UNKNOWN_CUSTOM_CODE", message: "Boom" });
    expect(session.getSnapshot().status.error?.code).toBe("SIMULATOR_ERROR");
    expect(session.getSnapshot().status.error?.message).toBe("Boom");
  });

  it("bounds interactive run lifetime and fails when exceeded", async () => {
    const { child } = createMockChildProcess();
    let currentTime = 1_000_000;
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      now: () => currentTime,
      maxRunDurationMs: 60_000,
    });

    await session.start();
    expect(session.getSnapshot().status.phase).toBe("starting");

    // Advance beyond maxRunDurationMs
    currentTime += 65_000;
    const snap = session.getSnapshot();
    expect(snap.status.phase).toBe("failed");
    expect(snap.status.error?.code).toBe("MOTION_TIMEOUT");
    expect(snap.status.error?.message).toContain("exceeded maximum bounded lifetime");
  });

  it("handles end command with resource teardown", async () => {
    const { child } = createMockChildProcess();
    const session = new SimulationBridgeSession({ spawnRunner: () => child });
    const startRes = await session.start();
    const runId = startRes.status.runId!;

    const endRes = await session.end(runId);
    expect(endRes.ok).toBe(true);
    expect(endRes.statusCode).toBe(200);
    expect(endRes.status.phase).toBe("ended");
  });

  it("ignores late callbacks from older child processes", async () => {
    const { child: child1 } = createMockChildProcess();
    const session = new SimulationBridgeSession({
      spawnRunner: () => child1,
    });

    const start1 = await session.start();
    const runId1 = start1.status.runId!;
    await session.end(runId1);

    // Old child emits data and close after teardown
    child1.emit("close", 1);
    expect(session.getSnapshot().status.phase).toBe("ended");
  });

  it("rejects wrong-run commands for status and end", async () => {
    const { child } = createMockChildProcess();
    const session = new SimulationBridgeSession({ spawnRunner: () => child });
    await session.start();

    const statusRes = session.getSnapshot("sim_wrong");
    expect(statusRes.ok).toBe(false);
    expect(statusRes.statusCode).toBe(400);
    expect(statusRes.error?.code).toBe("WRONG_RUN");

    const endRes = await session.end("sim_wrong");
    expect(endRes.ok).toBe(false);
    expect(endRes.statusCode).toBe(400);
    expect(endRes.error?.code).toBe("WRONG_RUN");
  });

  it("handles runner crash or startup failure with actionable terminal failure", async () => {
    const { child } = createMockChildProcess();
    const session = new SimulationBridgeSession({ spawnRunner: () => child });
    await session.start();

    child.emit("close", 2); // Exit code 2 = STARTUP_TIMEOUT
    const snap = session.getSnapshot();
    expect(snap.status.phase).toBe("failed");
    expect(snap.status.error?.code).toBe("SIMULATOR_ERROR");
    expect(snap.status.error?.exitCode).toBe(2);
  });

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

    // Mock child process where exitCode is set, but "close" event has NOT fired (stdio still open)
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

    // Call end - because "close" was not observed, it MUST NOT return early success on exitCode alone
    const endRes = await session.end(runId);

    // Hard deadline expired because close was never observed
    expect(endRes.ok).toBe(false);
    expect(endRes.statusCode).toBe(500);
    expect(endRes.error?.code).toBe("SIMULATOR_ERROR");
    expect(endRes.error?.message).toContain("within bounded deadline");

    // Ownership is retained: cannot start a new run while unconfirmed close
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

    // Call end with deferred cleanup
    const endPromise = session.end(runId);

    // While teardown is in flight, editor polls getSnapshot
    const inProgressSnap = session.getSnapshot();
    expect(inProgressSnap.status.phase).toBe("ending");
    expect(inProgressSnap.status.phase).not.toBe("ended");

    // Complete cleanup
    releaseCleanup();
    const endRes = await endPromise;

    // Verified cleanup
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

    // Unexpected runner close
    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 20));

    // Cleanup failed: status is failed, not ended
    const snap = session.getSnapshot();
    expect(snap.status.phase).toBe("failed");
    expect(snap.status.error?.code).toBe("CLEANUP_FAILURE");

    // Subsequent start rejected because uncleaned ownership is retained
    const startRetry = await session.start();
    expect(startRetry.ok).toBe(false);
    expect(startRetry.statusCode).toBe(409);
    expect(startRetry.error?.code).toBe("ALREADY_RUNNING");

    // Subsequent resume rejected
    const resumeRetry = await session.resume(runId);
    expect(resumeRetry.ok).toBe(false);

    // Operator explicit retry succeeds
    cleanupShouldFail = false;
    const retryEnd = await session.end(runId);
    expect(retryEnd.ok).toBe(true);
    expect(retryEnd.statusCode).toBe(200);
    expect(retryEnd.status.phase).toBe("ended");
    expect(retryEnd.status.error).toBeNull();

    // Now new start is allowed
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

    // Start still rejected because child close was not confirmed
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

    // Cancel early before runner emits any stdout
    const endRes = await session.end(runId);
    expect(endRes.ok).toBe(true);

    expect(cleanedContainers).toContain(`sim1_${runId}_px4`);
    expect(cleanedContainers).toContain(`sim1_${runId}_client`);
    expect(cleanedContainers.length).toBe(2);
  });

  it("handles non-fatal resume command rejection by runner, keeps holding phase and allows retry", async () => {
    const { child, stdoutStream } = createMockChildProcess();
    const currentTime = 1_000_000;
    const session = new SimulationBridgeSession({
      spawnRunner: () => child,
      now: () => currentTime,
    });

    const startRes = await session.start();
    const runId = startRes.status.runId!;

    stdoutStream.write(JSON.stringify({ type: "hold_confirmed", hold_confirmed: true }) + "\n");
    stdoutStream.write(JSON.stringify({ type: "phase", phase: "holding" }) + "\n");
    stdoutStream.write(
      JSON.stringify({
        type: "telemetry",
        timestamp: new Date(currentTime).toISOString(),
        lat: 47.397743,
        lon: 8.545594,
        alt_m: 10.0,
        speed_m_s: 0.0,
        north_speed_m_s: 0.0,
        north_progress_m: 8.0,
      }) + "\n"
    );

    const resumeRes = await session.resume(runId);
    expect(resumeRes.ok).toBe(true);

    // Runner rejects resume because segment is blocked
    stdoutStream.write(
      JSON.stringify({
        type: "error",
        code: "SEGMENT_BLOCKED",
        message: "Resume rejected: segment is blocked",
      }) + "\n"
    );

    // Phase remains holding (not failed)
    const snap1 = session.getSnapshot();
    expect(snap1.status.phase).toBe("holding");
    expect(snap1.status.error?.code).toBe("SEGMENT_BLOCKED");

    // Runner emits blockage cleared
    stdoutStream.write(JSON.stringify({ type: "blockage", blocked: false }) + "\n");

    // Resume retry is accepted
    const retryRes = await session.resume(runId);
    expect(retryRes.ok).toBe(true);
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
});
