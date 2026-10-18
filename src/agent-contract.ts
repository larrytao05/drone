import { z } from "zod";
import { planMission, type MissionInput, type Waypoint } from "./index.js";

export const AGENT_SCHEMA_VERSION = "1";
export const PLANNER_VERSION = "1";

export const agentBindingSchema = z.strictObject({
  missionBranchId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  schemaVersion: z.string().min(1).max(64),
  plannerVersion: z.string().min(1).max(64),
});
export type AgentBinding = z.infer<typeof agentBindingSchema>;

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

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answered"), text: agentMessageSchema, activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("needs-input"), question: z.string().trim().min(1).max(1_000), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("proposed"), change: missionChangeSchema, activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("failed"), activity: z.array(activitySchema).max(12), message: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal("cancelled"), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("deadline"), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("budget-exceeded"), activity: z.array(activitySchema).max(12) }),
  z.strictObject({ kind: z.literal("unavailable"), activity: z.array(activitySchema).max(12) }),
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

export async function digestMissionInput(input: MissionInput): Promise<string> {
  const bytes = new TextEncoder().encode(`mission-input:${PLANNER_VERSION}:${canonicalMissionInput(input)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
