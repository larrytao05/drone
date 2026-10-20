import { z } from "zod";
import { planMission, type MissionInput, type Waypoint } from "./index.js";

export const AGENT_SCHEMA_VERSION = "1";
export const PLANNER_VERSION = "1";
export const AGENT_RETRY_WINDOW_MS = 120_000;

export const agentEpochSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const agentRequestIdSchema = z.string().regex(/^[0-9a-f]{32}\.\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).max(128);
export const agentSessionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("logout") }),
  z.strictObject({ action: z.literal("login"), password: z.string().min(1).max(256) }),
]);
export const agentSessionResponseSchema = z.discriminatedUnion("authenticated", [
  z.strictObject({ authenticated: z.literal(false) }),
  z.strictObject({ authenticated: z.literal(true), epoch: agentEpochSchema, serverNow: z.number().int().nonnegative(), retryWindowMs: z.literal(AGENT_RETRY_WINDOW_MS) }),
]);
export type AgentSessionResponse = z.infer<typeof agentSessionResponseSchema>;

export function formatAgentRequestId(epoch: string, createdAt: number, uuid: string): string {
  return agentRequestIdSchema.parse(`${epoch}.${createdAt}.${uuid}`);
}

export function isCurrentAgentRequestId(requestId: string, epoch: string, now: number): boolean {
  if (!agentRequestIdSchema.safeParse(requestId).success) return false;
  const [requestEpoch, timestamp] = requestId.split(".");
  if (requestEpoch !== epoch) return false;
  const createdAt = Number(timestamp);
  return createdAt <= now + 5_000 && createdAt + AGENT_RETRY_WINDOW_MS > now;
}

export const agentBindingSchema = z.strictObject({
  missionBranchId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  schemaVersion: z.string().min(1).max(64),
  plannerVersion: z.string().min(1).max(64),
});
export type AgentBinding = z.infer<typeof agentBindingSchema>;

export function sameAgentBinding(left: AgentBinding, right: AgentBinding): boolean {
  return left.missionBranchId === right.missionBranchId && left.revision === right.revision
    && left.inputDigest === right.inputDigest && left.schemaVersion === right.schemaVersion
    && left.plannerVersion === right.plannerVersion;
}

export const agentMessageSchema = z.string().trim().min(1).max(4_000);
export const agentHistorySchema = z.array(z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: agentMessageSchema,
})).max(12).default([]);

export function isMissionInput(value: unknown): value is MissionInput {
  return planMission(value).kind === "calculated";
}

export const agentRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  message: agentMessageSchema,
  history: agentHistorySchema,
  snapshot: z.custom<MissionInput>(isMissionInput),
  binding: agentBindingSchema,
}).refine((request) => new TextEncoder().encode(JSON.stringify({
  requestId: request.requestId,
  message: request.message,
  history: request.history,
  binding: request.binding,
})).byteLength <= 24_000);
export type AgentRequest = z.infer<typeof agentRequestSchema>;

export const editorHeightChangeSchema = z.strictObject({
  kind: z.literal("set-height"),
  heightAboveTakeoffM: z.number().finite(),
});
export type EditorHeightChange = z.infer<typeof editorHeightChangeSchema>;

export const missionChangeSchema = z.discriminatedUnion("kind", [
  editorHeightChangeSchema,
  z.strictObject({ kind: z.literal("set-orbit-radius"), radiusM: z.number().finite().positive() }),
]);
export type MissionChange = z.infer<typeof missionChangeSchema>;
export type MissionCandidate = Readonly<{ input: MissionInput; waypoints: readonly Waypoint[] }>;

const activitySchema = z.strictObject({
  tool: z.enum(["get_mission_context", "preview_change", "propose_change", "ask_clarification"]),
  status: z.enum(["started", "succeeded", "rejected"]),
});
export type AgentActivity = z.infer<typeof activitySchema>;

export const agentFailureSchema = z.strictObject({
  code: z.enum(["provider-auth", "provider-rate-limit", "provider-unavailable", "model-unavailable", "provider-response", "provider-error", "invalid-tool-call", "tool-execution", "output-limit", "internal-error"]),
  status: z.number().int().min(400).max(599).optional(),
});
export type AgentFailure = z.infer<typeof agentFailureSchema>;

export const agentProgressEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["model-start", "model-end"]), elapsedMs: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.enum(["tool-start", "tool-end", "tool-rejected"]), tool: activitySchema.shape.tool, elapsedMs: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("terminal"), outcome: z.enum(["answered", "needs-input", "proposed", "failed", "cancelled", "deadline", "budget-exceeded", "unavailable"]), elapsedMs: z.number().int().nonnegative() }),
]);
export type AgentProgressEvent = z.infer<typeof agentProgressEventSchema>;
export const agentProgressRequestSchema = z.strictObject({ requestId: agentRequestIdSchema, binding: agentBindingSchema });
export const agentProgressResponseSchema = z.strictObject({
  requestId: agentRequestIdSchema,
  binding: agentBindingSchema,
  state: z.enum(["running", "completed"]),
  elapsedMs: z.number().int().nonnegative(),
  events: z.array(agentProgressEventSchema).max(16),
});
export type AgentProgressResponse = z.infer<typeof agentProgressResponseSchema>;

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answered"), text: agentMessageSchema, activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("needs-input"), question: z.string().trim().min(1).max(1_000), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("proposed"), change: missionChangeSchema, activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("failed"), activity: z.array(activitySchema).max(12), message: z.string().max(200).optional(), diagnostic: agentFailureSchema.optional() }),
  z.strictObject({ kind: z.literal("cancelled"), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("deadline"), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("budget-exceeded"), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("unavailable"), activity: z.array(activitySchema).max(12), diagnostic: agentFailureSchema.optional() }),
]);
export const agentResponseSchema = z.strictObject({
  requestId: agentRequestSchema.shape.requestId,
  binding: agentBindingSchema,
  outcome: outcomeSchema,
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export function previewMissionChange(
  input: MissionInput,
  change: MissionChange,
): { kind: "valid"; candidate: MissionCandidate; summary: unknown } | { kind: "invalid"; diagnostics: unknown } {
  let candidateInput: MissionInput;
  if (change.kind === "set-height") {
    candidateInput = { ...input, heightAboveTakeoffM: change.heightAboveTakeoffM };
  } else {
    if (input.shot.kind !== "orbit") {
      return { kind: "invalid", diagnostics: [{ path: ["shot", "radiusM"], code: "unsupported", message: "Orbit radius applies only to orbit missions." }] };
    }
    candidateInput = { ...input, shot: { ...input.shot, radiusM: change.radiusM } };
  }
  const result = planMission(candidateInput);
  if (result.kind === "invalid-input") {
    return { kind: "invalid", diagnostics: result.issues.map(({ path, code, message }) => ({ path, code, message })) };
  }
  return {
    kind: "valid",
    candidate: { input: candidateInput, waypoints: result.waypoints },
    summary: {
      shotKind: candidateInput.shot.kind,
      heightAboveTakeoffM: candidateInput.heightAboveTakeoffM,
      ...(candidateInput.shot.kind === "orbit" ? { radiusM: candidateInput.shot.radiusM } : {}),
      waypointCount: result.waypoints.length,
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(Object.getOwnPropertyDescriptor(value, key)?.value)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Expected validated JSON");
  return encoded;
}

export function canonicalMissionInput(input: MissionInput): string {
  if (!isMissionInput(input)) throw new Error("Invalid mission input");
  return canonicalJson(input);
}

export function canonicalAgentRequest(request: AgentRequest): string {
  return canonicalJson(request);
}

export async function digestMissionInput(input: MissionInput): Promise<string> {
  const bytes = new TextEncoder().encode(`mission-input:${PLANNER_VERSION}:${canonicalMissionInput(input)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
