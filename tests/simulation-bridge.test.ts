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


  it("starts with validated route and rejects unsupported route input", async () => {
    let capturedArgs: string[] = [];
    const { child } = createMockChildProcess();
    const session = new SimulationBridgeSession({
      spawnRunner: (_cmd, args) => {
        capturedArgs = args;
        return child;
      },
      cleanupContainers: async () => true,
    });

    // 1. Rejects route with negative altitude
    const badAlt = await session.start({
      plannedAltitudeM: -5,
      waypoints: [
        { latitudeDeg: 47.39, longitudeDeg: 8.54, altitudeM: 10 },
        { latitudeDeg: 47.40, longitudeDeg: 8.55, altitudeM: 10 },
      ],
    });
    expect(badAlt.ok).toBe(false);
    expect(badAlt.error?.code).toBe("INVALID_REQUEST");

    // 2. Rejects route with fewer than 2 waypoints
    const oneWp = await session.start({
      plannedAltitudeM: 10,
      waypoints: [{ latitudeDeg: 47.39, longitudeDeg: 8.54, altitudeM: 10 }],
    });
    expect(oneWp.ok).toBe(false);
    expect(oneWp.error?.code).toBe("INVALID_REQUEST");

    // 3. Rejects waypoint with invalid latitude
    const badLat = await session.start({
      plannedAltitudeM: 10,
      waypoints: [
        { latitudeDeg: 95.0, longitudeDeg: 8.54, altitudeM: 10 },
        { latitudeDeg: 47.40, longitudeDeg: 8.55, altitudeM: 10 },
      ],
    });
    expect(badLat.ok).toBe(false);
    expect(badLat.error?.code).toBe("INVALID_REQUEST");

    // 4. Accepts valid route and passes --route-json to runner
    const validRoute = {
      name: "Survey Test",
      plannedAltitudeM: 15,
      speedMs: 3.5,
      waypoints: [
        { latitudeDeg: 47.398043, longitudeDeg: 8.545594, altitudeM: 15 },
        { latitudeDeg: 47.398043, longitudeDeg: 8.545994, altitudeM: 15 },
      ],
    };
    const validStart = await session.start(validRoute);
    expect(validStart.ok).toBe(true);
    expect(capturedArgs).toContain("--route-json");
    expect(capturedArgs).toContain(JSON.stringify(validRoute.waypoints));
    expect(capturedArgs).toContain("--alt");
    expect(capturedArgs).toContain("15");
    expect(capturedArgs).toContain("--speed");
    expect(capturedArgs).toContain("3.5");
    expect(session.getSnapshot().status.route?.name).toBe("Survey Test");

    await session.end(validStart.status.runId!);
  });
});
