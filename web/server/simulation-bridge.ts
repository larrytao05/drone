import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isAllowedLocalOrigin,
  isLoopbackHost,
  SIMULATION_MAX_SAMPLE_AGE_MS,
  simulationCommandRequestSchema,
  simulationErrorCodeSchema,
  simulationPhaseSchema,
  simulationRouteInputSchema,
  type SimulationCommandRequest,
  type SimulationError,
  type SimulationEvent,
  type SimulationPhase,
  type SimulationRouteInput,
  type SimulationStatus,
  type SimulationTelemetry,
} from "../../src/simulation-contract.ts";

const execFileAsync = promisify(execFile);

export type SpawnRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ("pipe" | "inherit")[] }
) => ChildProcess;

export type TeardownTimeouts = Readonly<{
  termMs?: number;
  killMs?: number;
  hardDeadlineMs?: number;
}>;

export type SimulationBridgeOptions = Readonly<{
  spawnRunner?: SpawnRunner;
  repoRoot?: string;
  allowedOrigin?: string;
  now?: () => number;
  dockerMode?: boolean;
  maxRunDurationMs?: number;
  cleanupContainers?: (containers: readonly string[]) => Promise<boolean>;
  teardownTimeouts?: TeardownTimeouts;
}>;

export type SessionResult = {
  ok: boolean;
  status: SimulationStatus;
  error?: SimulationError;
  statusCode: number;
};

export function generateRunId(now: number = Date.now()): string {
  return `sim_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function getRunContainerNames(runId: string): readonly [string, string] {
  if (!/^sim[a-zA-Z0-9_]+$/.test(runId)) {
    throw new Error(`Invalid runId for container naming: '${runId}'`);
  }
  return [`sim1_${runId}_px4`, `sim1_${runId}_client`] as const;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

type ActiveRun = {
  readonly runId: string;
  readonly containers: readonly [string, string];
  readonly startedAt: number;
  child: ChildProcess | null;
  teardownPromise: Promise<SessionResult> | null;
  teardownInitiated: boolean;
  processExited: boolean;
  cleanupCompleted: boolean;
  failedCleanup: boolean;
  originalFailure: SimulationError | null;
};

export class SimulationBridgeSession {
  private runId: string | null = null;
  private seq = 0;
  private phase: SimulationPhase = "ready";
  private blocked = false;
  private holdRequested = false;
  private holdConfirmed = false;
  private resumePending = false;
  private telemetry: SimulationTelemetry | null = null;
  private telemetryReceivedAt = 0;
  private events: SimulationEvent[] = [];
  private error: SimulationError | null = null;
  private trackedContainers: string[] = [];
  private lineBuffer = "";
  private runStartedAt = 0;
  private activeRun: ActiveRun | null = null;
  private executedRoute: SimulationRouteInput | null = null;

  private readonly spawnRunner: SpawnRunner;
  private readonly repoRoot: string;
  private readonly now: () => number;
  private readonly dockerMode: boolean;
  private readonly maxRunDurationMs: number;
  private readonly customCleanupContainers?: ((containers: readonly string[]) => Promise<boolean>) | undefined;
  private readonly teardownTimeouts: { termMs: number; killMs: number; hardDeadlineMs: number };

  constructor(options?: SimulationBridgeOptions) {
    this.spawnRunner = options?.spawnRunner ?? spawn;
    this.repoRoot = options?.repoRoot ?? process.cwd();
    this.now = options?.now ?? Date.now;
    this.dockerMode = options?.spawnRunner ? (options?.dockerMode ?? true) : true;
    this.maxRunDurationMs = options?.maxRunDurationMs ?? 600_000;
    this.customCleanupContainers = options?.cleanupContainers;
    this.teardownTimeouts = {
      termMs: options?.teardownTimeouts?.termMs ?? 4000,
      killMs: options?.teardownTimeouts?.killMs ?? 2000,
      hardDeadlineMs: options?.teardownTimeouts?.hardDeadlineMs ?? 2000,
    };
  }

  private incrementSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private recordEvent(label: string): SimulationEvent {
    const seq = this.incrementSeq();
    const event: SimulationEvent = {
      seq,
      timestamp: new Date(this.now()).toISOString(),
      label,
    };
    this.events.push(event);
    return event;
  }

  private result(statusCode: number, error?: SimulationError): SessionResult {
    return {
      ok: statusCode < 400,
      status: this.buildStatus(),
      ...(error ? { error } : {}),
      statusCode,
    };
  }

  public getSnapshot(requestedRunId?: string): SessionResult {
    if (requestedRunId && this.runId && requestedRunId !== this.runId) {
      return this.result(400, {
        code: "WRONG_RUN",
        message: `Command target runId '${requestedRunId}' does not match active runId '${this.runId}'.`,
      });
    }
    return this.result(200);
  }

  private buildStatus(): SimulationStatus {
    const now = this.now();
    let currentTelemetry: SimulationTelemetry | null = null;
    let fresh = false;

    // Bounded interactive run lifetime watchdog
    if (
      this.runStartedAt > 0 &&
      (this.phase === "starting" || this.phase === "running" || this.phase === "holding")
    ) {
      if (now - this.runStartedAt > this.maxRunDurationMs) {
        this.phase = "failed";
        if (!this.error) {
          this.error = {
            code: "MOTION_TIMEOUT",
            message: `Simulation run exceeded maximum bounded lifetime of ${Math.round(this.maxRunDurationMs / 1000)}s.`,
          };
        }
        if (this.activeRun) {
          if (!this.activeRun.originalFailure) {
            this.activeRun.originalFailure = this.error;
          }
          void this.coordinateRunTeardown(this.activeRun);
        }
      }
    }

    if (this.telemetry) {
      const sampleAgeMs = Math.max(0, now - this.telemetryReceivedAt);
      fresh = sampleAgeMs <= SIMULATION_MAX_SAMPLE_AGE_MS;
      currentTelemetry = { ...this.telemetry, sampleAgeMs };
    }

    const cleanupCompleted = this.activeRun ? this.activeRun.cleanupCompleted : true;

    return {
      runId: this.runId,
      seq: this.seq,
      phase: this.phase,
      blocked: this.blocked,
      holdRequested: this.holdRequested,
      holdConfirmed: this.holdConfirmed,
      fresh,
      cleanupCompleted,
      route: this.executedRoute,
      telemetry: currentTelemetry,
      events: [...this.events],
      error: this.error ? { ...this.error } : null,
    };
  }

  public async start(route?: SimulationRouteInput): Promise<SessionResult> {
    if (this.activeRun !== null && !this.activeRun.cleanupCompleted) {
      return this.result(409, {
        code: "ALREADY_RUNNING",
        message: `A simulation run (${this.activeRun.runId}) is already active or undergoing teardown.`,
      });
    }

    if (route) {
      const parsed = simulationRouteInputSchema.safeParse(route);
      if (!parsed.success) {
        return this.result(400, {
          code: "INVALID_REQUEST",
          message: `Simulation route validation failed: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        });
      }
      this.executedRoute = parsed.data;
    } else {
      this.executedRoute = null;
    }

    const newRunId = generateRunId(this.now());
    const containers = getRunContainerNames(newRunId);

    this.runId = newRunId;
    this.seq = 0;
    this.phase = "starting";
    this.runStartedAt = this.now();
    this.blocked = false;
    this.holdRequested = false;
    this.holdConfirmed = false;
    this.resumePending = false;
    this.telemetry = null;
    this.telemetryReceivedAt = 0;
    this.events = [];
    this.error = null;
    this.trackedContainers = [...containers];
    this.lineBuffer = "";

    this.recordEvent("Simulation run initialized");

    const run: ActiveRun = {
      runId: newRunId,
      containers,
      startedAt: this.now(),
      child: null,
      teardownPromise: null,
      teardownInitiated: false,
      processExited: false,
      cleanupCompleted: false,
      failedCleanup: false,
      originalFailure: null,
    };
    this.activeRun = run;

    const args = [
      "-u",
      "scripts/sim1_run_route.py",
      "--interactive",
      "--run-id",
      newRunId,
      "--max-runtime",
      String(Math.round(this.maxRunDurationMs / 1000)),
    ];
    if (this.dockerMode) args.push("--docker");
    if (route) {
      args.push("--alt", String(route.plannedAltitudeM));
      if (route.speedMs) args.push("--speed", String(route.speedMs));
      args.push("--route-json", JSON.stringify(route.waypoints));
    }

    try {
      run.child = this.spawnRunner("python3", args, {
        cwd: this.repoRoot,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      run.processExited = true;
      run.cleanupCompleted = true;
      this.phase = "failed";
      this.error = {
        code: "SIMULATOR_ERROR",
        message: `Failed to spawn Python simulation runner: ${err instanceof Error ? err.message : String(err)}`,
      };
      run.originalFailure = this.error;
      return this.result(500, this.error);
    }

    const childRef = run.child;

    if (childRef.stdout) {
      childRef.stdout.on("data", (chunk: Buffer) => {
        if (this.activeRun !== run || run.child !== childRef) return;
        this.consumeStdout(chunk.toString("utf-8"));
      });
    }

    childRef.stderr?.resume();

    const recordRunnerFailure = (failure: SimulationError) => {
      run.originalFailure ??= failure;
      this.phase = "failed";
      this.error = run.originalFailure;
      this.recordEvent(failure.message);
    };

    childRef.on("error", (error) => {
      if (this.activeRun !== run || run.child !== childRef) return;
      recordRunnerFailure({
        code: "SIMULATOR_ERROR",
        message: `Simulation runner process error: ${error.message}`,
      });
      void this.coordinateRunTeardown(run);
    });

    childRef.on("close", (code, signal) => {
      if (this.activeRun !== run || run.child !== childRef) return;
      run.processExited = true;
      run.child = null;

      if (!run.teardownInitiated && (code !== 0 || signal != null)) {
        recordRunnerFailure({
          code: "SIMULATOR_ERROR",
          message: signal
            ? `Simulation runner terminated by signal ${signal}`
            : `Simulation runner process exited with status ${code}`,
          ...(code === null ? {} : { exitCode: code }),
        });
      }
      void this.coordinateRunTeardown(run);
    });

    return this.result(200);
  }

  private consumeStdout(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line);
        this.handleRunnerMessage(parsed);
      } catch {
        // Not a JSON-line
      }
    }
  }

  public handleRunnerMessage(message: Record<string, unknown>): void {
    const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

    switch (message.type) {
      case "phase": {
        const parsed = simulationPhaseSchema.safeParse(message.phase);
        if (parsed.success) {
          if (this.activeRun?.teardownInitiated || this.phase === "failed" || parsed.data === "ended") break;
          this.phase = parsed.data;
          if (this.phase === "running") {
            this.holdRequested = false;
            this.holdConfirmed = false;
            this.resumePending = false;
            this.error = null;
          }
          this.incrementSeq();
        }
        break;
      }
      case "event": {
        if (typeof message.label === "string" && message.label.length > 0) {
          this.recordEvent(message.label);
          if (!this.activeRun?.teardownInitiated && this.phase !== "failed" && message.label === "Route motion resumed") {
            this.holdRequested = false;
            this.holdConfirmed = false;
            this.resumePending = false;
            this.error = null;
          }
        }
        break;
      }
      case "telemetry": {
        if (
          isNum(message.lat) &&
          isNum(message.lon) &&
          isNum(message.alt_m) &&
          isNum(message.north_progress_m) &&
          isNum(message.speed_m_s) &&
          isNum(message.north_speed_m_s)
        ) {
          const timestamp =
            typeof message.timestamp === "string" && message.timestamp.length > 0
              ? message.timestamp
              : new Date(this.now()).toISOString();

          this.telemetryReceivedAt = this.now();
          this.telemetry = {
            timestamp,
            sampleAgeMs: 0,
            position: {
              lat: message.lat,
              lon: message.lon,
              altM: message.alt_m,
              northProgressM: message.north_progress_m,
            },
            velocity: {
              speedMs: message.speed_m_s,
              northSpeedMs: message.north_speed_m_s,
            },
          };
          this.incrementSeq();
        }
        break;
      }
      case "blockage": {
        if (typeof message.blocked === "boolean") {
          this.blocked = message.blocked;
          this.incrementSeq();
        }
        break;
      }
      case "hold_requested": {
        if (typeof message.hold_requested === "boolean") {
          this.holdRequested = message.hold_requested;
          this.incrementSeq();
        }
        break;
      }
      case "hold_confirmed": {
        if (typeof message.hold_confirmed === "boolean") {
          this.holdConfirmed = message.hold_confirmed;
          this.incrementSeq();
        }
        break;
      }
      case "route": {
        if (Array.isArray(message.waypoints)) {
          this.incrementSeq();
        }
        break;
      }
      case "containers": {
        if (
          Array.isArray(message.containers) &&
          message.containers.every((c) => typeof c === "string" && c.length > 0)
        ) {
          const emitted = message.containers.map(String);
          if (this.activeRun) {
            const owned = new Set(this.activeRun.containers);
            if (!emitted.every((c) => owned.has(c))) {
              this.error = {
                code: "SAFETY_VIOLATION",
                message: "Runner emitted container identities outside the preassigned run namespace.",
              };
              this.phase = "failed";
              this.incrementSeq();
              if (this.activeRun) {
                if (!this.activeRun.originalFailure) {
                  this.activeRun.originalFailure = this.error;
                }
                void this.coordinateRunTeardown(this.activeRun);
              }
              break;
            }
          }
          this.trackedContainers = emitted;
        }
        break;
      }
      case "cleanup": {
        if (message.success === false) {
          this.error = {
            code: "CLEANUP_FAILURE",
            message: "Failed to remove simulator containers during teardown",
          };
          this.phase = "failed";
          this.incrementSeq();
        }
        break;
      }
      case "error": {
        const codeParsed = simulationErrorCodeSchema.safeParse(message.code);
        const code = codeParsed.success ? codeParsed.data : "SIMULATOR_ERROR";
        const msg =
          typeof message.message === "string" && message.message.length > 0
            ? message.message
            : "Unknown runner error";

        this.resumePending = false;
        this.error = { code, message: msg };

        const isCommandRejection =
          code === "NOT_HOLDING" ||
          code === "SEGMENT_BLOCKED" ||
          code === "STALE_TELEMETRY" ||
          code === "INVALID_REQUEST";

        if (isCommandRejection) {
          this.recordEvent(`Runner rejected command [${code}]: ${msg}`);
        } else {
          this.phase = "failed";
          if (this.activeRun) {
            if (!this.activeRun.originalFailure) {
              this.activeRun.originalFailure = this.error;
            }
            void this.coordinateRunTeardown(this.activeRun);
          }
        }
        this.incrementSeq();
        break;
      }
    }
  }

  public async resume(runId: string): Promise<SessionResult> {
    if (!this.activeRun || this.activeRun.runId !== runId) {
      return this.result(400, {
        code: "WRONG_RUN",
        message: `Resume rejected: runId '${runId}' does not match active run '${this.activeRun?.runId ?? this.runId}'.`,
      });
    }

    if (this.activeRun.teardownInitiated || this.activeRun.failedCleanup) {
      return this.result(400, {
        code: "NOT_HOLDING",
        message: "Resume rejected: simulation is undergoing teardown or has uncleaned resources.",
      });
    }

    if (this.phase !== "holding" || !this.holdConfirmed) {
      return this.result(400, {
        code: "NOT_HOLDING",
        message: `Resume rejected: simulation is not in confirmed hold (current phase: '${this.phase}').`,
      });
    }

    if (this.blocked) {
      return this.result(400, {
        code: "SEGMENT_BLOCKED",
        message: "Resume rejected: segment remains blocked.",
      });
    }

    const sampleAge = this.telemetry ? Math.max(0, this.now() - this.telemetryReceivedAt) : Infinity;
    if (sampleAge > SIMULATION_MAX_SAMPLE_AGE_MS) {
      return this.result(400, {
        code: "STALE_TELEMETRY",
        message: `Resume rejected: telemetry is stale (${sampleAge}ms old, limit is ${SIMULATION_MAX_SAMPLE_AGE_MS}ms).`,
      });
    }

    if (this.resumePending) {
      return this.result(409, {
        code: "INVALID_REQUEST",
        message: "Resume rejected: resume command is already in flight.",
      });
    }

    const stdin = this.activeRun.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return this.result(500, {
        code: "SIMULATOR_ERROR",
        message: "Runner input transport is not writable.",
      });
    }

    try {
      stdin.write(JSON.stringify({ command: "resume", runId }) + "\n");
    } catch (err) {
      return this.result(500, {
        code: "SIMULATOR_ERROR",
        message: `Failed to write resume command: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    this.resumePending = true;
    this.recordEvent("Operator requested explicit resume (queued to runner)");
    return this.result(200);
  }

  public async end(runId: string): Promise<SessionResult> {
    if (!this.activeRun || this.activeRun.runId !== runId) {
      return this.result(400, {
        code: "WRONG_RUN",
        message: `End rejected: runId '${runId}' does not match active run '${this.activeRun?.runId ?? this.runId}'.`,
      });
    }

    return await this.coordinateRunTeardown(this.activeRun);
  }

  private coordinateRunTeardown(run: ActiveRun): Promise<SessionResult> {
    if (run.teardownPromise) {
      return run.teardownPromise;
    }
    if (run.cleanupCompleted && !run.failedCleanup) {
      return Promise.resolve(this.result(200));
    }

    if (this.phase !== "failed") {
      this.phase = "ending";
      this.incrementSeq();
    }
    if (!run.teardownInitiated) {
      run.teardownInitiated = true;
      this.recordEvent("Simulation teardown initiated");
    }

    const teardownPromise = (async () => {
      try {
        return await this.performRunTeardown(run);
      } finally {
        run.teardownPromise = null;
      }
    })();

    run.teardownPromise = teardownPromise;
    return teardownPromise;
  }

  private async performRunTeardown(run: ActiveRun): Promise<SessionResult> {
    // 1. Process termination: wait for confirmed close, never release on signal alone
    if (run.child && !run.processExited) {
      const childRef = run.child;
      try {
        if (childRef.stdin && !childRef.stdin.destroyed && childRef.stdin.writable) {
          childRef.stdin.write(JSON.stringify({ command: "end", runId: run.runId }) + "\n");
        }
      } catch {
        // Ignored
      }

      const closed = await new Promise<boolean>((resolve) => {
        if (run.processExited) {
          resolve(true);
          return;
        }

        let settled = false;
        const finish = (success: boolean) => {
          if (!settled) {
            settled = true;
            resolve(success);
          }
        };

        const closeHandler = () => {
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          clearTimeout(hardDeadlineTimer);
          run.processExited = true;
          finish(true);
        };

        childRef.once("close", closeHandler);

        const { termMs, killMs, hardDeadlineMs } = this.teardownTimeouts;
        const termTimer = setTimeout(() => {
          try { childRef.kill("SIGTERM"); } catch {}
        }, termMs);
        if (typeof termTimer.unref === "function") termTimer.unref();

        const killTimer = setTimeout(() => {
          try { childRef.kill("SIGKILL"); } catch {}
        }, termMs + killMs);
        if (typeof killTimer.unref === "function") killTimer.unref();

        const hardDeadlineTimer = setTimeout(() => {
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          childRef.removeListener("close", closeHandler);
          finish(false);
        }, termMs + killMs + hardDeadlineMs);
        if (typeof hardDeadlineTimer.unref === "function") hardDeadlineTimer.unref();
      });

      if (!closed) {
        run.failedCleanup = true;
        run.cleanupCompleted = false;
        this.phase = "failed";
        this.error = {
          code: "SIMULATOR_ERROR",
          message: "Failed to terminate simulation runner process within bounded deadline.",
        };
        this.incrementSeq();
        return this.result(500, this.error);
      }

      run.processExited = true;
      run.child = null;
    }

    // 2. Container cleanup: remove run-owned containers
    const cleanupSuccess = await this.cleanupContainers(run.containers);

    if (!cleanupSuccess) {
      run.failedCleanup = true;
      run.cleanupCompleted = false;
      this.phase = "failed";
      this.error = {
        code: "CLEANUP_FAILURE",
        message: "Failed to confirm container cleanup during simulation teardown.",
      };
      this.incrementSeq();
      this.recordEvent("Container cleanup failed during teardown");
      return this.result(500, this.error);
    }

    run.failedCleanup = false;
    run.cleanupCompleted = true;

    this.phase = run.originalFailure ? "failed" : "ended";
    this.error = run.originalFailure;
    this.recordEvent(run.originalFailure
      ? "Simulation teardown completed after runner failure"
      : "Simulation ended and verified");
    return this.result(200);
  }

  public async cleanupContainers(containersToClean?: readonly string[]): Promise<boolean> {
    const containers = containersToClean ?? this.activeRun?.containers ?? this.trackedContainers;
    if (!containers || containers.length === 0) return true;
    if (this.customCleanupContainers) {
      return await this.customCleanupContainers(containers);
    }
    let allClean = true;
    for (const container of containers) {
      try {
        await execFileAsync("docker", ["rm", "-f", container], { timeout: 10_000 });
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string }).stderr ?? "";
        if (!stderr.includes("No such container")) allClean = false;
      }
    }
    return allClean;
  }
}

export function createSimulationBridgeHandlers(options?: SimulationBridgeOptions): {
  get: (request: Request) => Promise<Response>;
  post: (request: Request) => Promise<Response>;
  session: SimulationBridgeSession;
} {
  const session = new SimulationBridgeSession(options);
  const allowedOriginEnv = options?.allowedOrigin ?? process.env.SIMULATION_ALLOWED_ORIGIN;

  function validateOrigin(request: Request, isCommand: boolean): boolean {
    if (request.headers.get("sec-fetch-site") === "cross-site") return false;
    const origin = request.headers.get("origin");
    if (origin) return isAllowedLocalOrigin(origin, allowedOriginEnv);
    if (isCommand) return false;
    const host = request.headers.get("host")?.trim();
    if (!host) return false;
    try {
      const url = new URL(`http://${host}`);
      if (allowedOriginEnv?.trim()) {
        const allowed = new URL(allowedOriginEnv.trim());
        return url.host === allowed.host || url.hostname === allowed.hostname;
      }
      return isLoopbackHost(url.hostname);
    } catch {
      return false;
    }
  }

  function respond({ statusCode, ...body }: SessionResult): Response {
    return json(statusCode, body);
  }

  async function get(request: Request): Promise<Response> {
    if (!validateOrigin(request, false)) {
      return json(403, {
        ok: false,
        error: { code: "FORBIDDEN_ORIGIN", message: "Forbidden origin" },
      });
    }

    const url = new URL(request.url);
    const runId = url.searchParams.get("runId") ?? undefined;
    const res = session.getSnapshot(runId);
    return respond(res);
  }

  async function post(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Invalid JSON request body" },
      });
    }

    const parseResult = simulationCommandRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return json(400, {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Request validation failed: ${parseResult.error.message}`,
        },
      });
    }

    const command: SimulationCommandRequest = parseResult.data;
    const isCommand = command.action !== "status";

    if (!validateOrigin(request, isCommand)) {
      return json(403, {
        ok: false,
        error: { code: "FORBIDDEN_ORIGIN", message: "Forbidden origin" },
      });
    }

    switch (command.action) {
      case "start": {
        const res = await session.start(command.route);
        return respond(res);
      }
      case "status": {
        const res = session.getSnapshot(command.runId);
        return respond(res);
      }
      case "resume": {
        const res = await session.resume(command.runId);
        return respond(res);
      }
      case "end": {
        const res = await session.end(command.runId);
        return respond(res);
      }
    }
  }

  return { get, post, session };
}
