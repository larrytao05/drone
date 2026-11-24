import { z } from "zod";

export const SIMULATION_SCHEMA_VERSION = "1";
export const SIMULATION_MAX_SAMPLE_AGE_MS = 2_000;

export const simulationPhaseSchema = z.enum([
  "ready",
  "starting",
  "running",
  "holding",
  "completed",
  "ending",
  "ended",
  "failed",
]);
export type SimulationPhase = z.infer<typeof simulationPhaseSchema>;

export const telemetryPositionSchema = z.strictObject({
  lat: z.number().finite(),
  lon: z.number().finite(),
  altM: z.number().finite(),
  northProgressM: z.number().finite(),
});
export type TelemetryPosition = z.infer<typeof telemetryPositionSchema>;

export const telemetryVelocitySchema = z.strictObject({
  speedMs: z.number().finite(),
  northSpeedMs: z.number().finite(),
});
export type TelemetryVelocity = z.infer<typeof telemetryVelocitySchema>;

export const simulationTelemetrySchema = z.strictObject({
  timestamp: z.string().min(1),
  sampleAgeMs: z.number().int().nonnegative(),
  position: telemetryPositionSchema,
  velocity: telemetryVelocitySchema,
});
export type SimulationTelemetry = z.infer<typeof simulationTelemetrySchema>;

export const simulationEventSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  label: z.string().min(1),
});
export type SimulationEvent = z.infer<typeof simulationEventSchema>;

export const simulationErrorCodeSchema = z.enum([
  "STARTUP_TIMEOUT",
  "MOTION_TIMEOUT",
  "SAFETY_VIOLATION",
  "SIMULATOR_ERROR",
  "CLEANUP_FAILURE",
  "PREREQUISITE_MISSING",
  "WRONG_RUN",
  "ALREADY_RUNNING",
  "NOT_RUNNING",
  "NOT_HOLDING",
  "SEGMENT_BLOCKED",
  "STALE_TELEMETRY",
  "FORBIDDEN_ORIGIN",
  "INVALID_REQUEST",
  "ABORTED",
]);
export type SimulationErrorCode = z.infer<typeof simulationErrorCodeSchema>;

export const simulationErrorSchema = z.strictObject({
  code: simulationErrorCodeSchema,
  message: z.string().min(1),
  exitCode: z.number().int().optional(),
});
export type SimulationError = z.infer<typeof simulationErrorSchema>;

export const simulationLegStageSchema = z.enum(["takeoff", "leg", "completed"]);
export type SimulationLegStage = z.infer<typeof simulationLegStageSchema>;

export const simulationLegProgressSchema = z.strictObject({
  stage: simulationLegStageSchema,
  legIndex: z.number().int().nonnegative().optional(),
  fromWaypointIndex: z.number().int().nonnegative().optional(),
  toWaypointIndex: z.number().int().nonnegative().optional(),
  fromWaypointId: z.string().optional(),
  toWaypointId: z.string().optional(),
  legProgressM: z.number().finite().optional(),
  legTotalDistanceM: z.number().finite().optional(),
});
export type SimulationLegProgress = z.infer<typeof simulationLegProgressSchema>;

export const simulationWaypointInputSchema = z.strictObject({
  id: z.string().optional(),
  latitudeDeg: z.number().finite().min(-90).max(90),
  longitudeDeg: z.number().finite().min(-180).max(180),
  altitudeM: z.number().finite().positive().max(120),
  speedMs: z.number().finite().positive().optional(),
});
export type SimulationWaypointInput = z.infer<typeof simulationWaypointInputSchema>;

export const simulationRouteInputSchema = z.strictObject({
  name: z.string().optional(),
  plannedAltitudeM: z.number().finite().positive().max(120),
  speedMs: z.number().finite().positive().optional(),
  waypoints: z.array(simulationWaypointInputSchema).min(2),
});
export type SimulationRouteInput = z.infer<typeof simulationRouteInputSchema>;

export const simulationStatusSchema = z.strictObject({
  runId: z.string().min(1).nullable(),
  seq: z.number().int().nonnegative(),
  phase: simulationPhaseSchema,
  blocked: z.boolean(),
  holdRequested: z.boolean(),
  holdConfirmed: z.boolean(),
  fresh: z.boolean(),
  cleanupCompleted: z.boolean(),
  route: simulationRouteInputSchema.nullable().optional(),
  telemetry: simulationTelemetrySchema.nullable(),
  activeLeg: simulationLegProgressSchema.nullable().optional(),
  blockedLeg: simulationLegProgressSchema.nullable().optional(),
  events: z.array(simulationEventSchema),
  error: simulationErrorSchema.nullable(),
});
export type SimulationStatus = z.infer<typeof simulationStatusSchema>;

export const simulationStartRequestSchema = z.strictObject({
  action: z.literal("start"),
  route: simulationRouteInputSchema.optional(),
});

export const simulationStatusRequestSchema = z.strictObject({
  action: z.literal("status"),
  runId: z.string().min(1).optional(),
});

export const simulationResumeRequestSchema = z.strictObject({
  action: z.literal("resume"),
  runId: z.string().min(1),
});

export const simulationEndRequestSchema = z.strictObject({
  action: z.literal("end"),
  runId: z.string().min(1),
});

export const simulationCommandRequestSchema = z.discriminatedUnion("action", [
  simulationStartRequestSchema,
  simulationStatusRequestSchema,
  simulationResumeRequestSchema,
  simulationEndRequestSchema,
]);
export type SimulationCommandRequest = z.infer<typeof simulationCommandRequestSchema>;

export const simulationResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), status: simulationStatusSchema }),
  z.strictObject({ ok: z.literal(false), status: simulationStatusSchema.optional(), error: simulationErrorSchema }),
]);
export type SimulationResponse = z.infer<typeof simulationResponseSchema>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false;
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function isAllowedLocalOrigin(
  origin: string | null | undefined,
  allowedOriginEnv?: string
): boolean {
  if (!origin) return true; // Direct local/CLI callers without Origin header
  const clean = origin.trim();
  if (!clean) return true;

  if (allowedOriginEnv && allowedOriginEnv.trim()) {
    return clean === allowedOriginEnv.trim();
  }

  try {
    const url = new URL(clean);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}
