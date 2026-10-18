import { describe, expect, it } from "vitest";
import { planMission, type MissionInput } from "../src/index.js";
import {
  AGENT_RETRY_WINDOW_MS, AGENT_SCHEMA_VERSION, PLANNER_VERSION, agentRequestSchema, agentResponseSchema,
  agentSessionRequestSchema, agentSessionResponseSchema, canonicalMissionInput, digestMissionInput,
  editorHeightChangeSchema, formatAgentRequestId, isCurrentAgentRequestId, missionChangeSchema, previewMissionChange,
} from "../src/agent-contract.js";

const route: MissionInput = {
  shot: { kind: "route", anchors: [{ latitudeDeg: 40, longitudeDeg: -70 }, { latitudeDeg: 40.001, longitudeDeg: -70.001 }] },
  heightAboveTakeoffM: 20,
  framing: { kind: "fixed", headingDeg: 45, gimbalPitchDeg: -10 },
};
const orbit: MissionInput = {
  shot: { kind: "orbit", centre: { latitudeDeg: 40, longitudeDeg: -70 }, radiusM: 30, startBearingDeg: 0, direction: "clockwise", arc: { kind: "closed" } },
  heightAboveTakeoffM: 20,
  framing: { kind: "fixed", headingDeg: 45, gimbalPitchDeg: -10 },
};

describe("browser agent contract", () => {
  it("defines a bounded session bootstrap and finite request-ID lease", () => {
    const epoch = "a".repeat(32);
    const now = 1_800_000_000_000;
    const requestId = formatAgentRequestId(epoch, now, "123e4567-e89b-42d3-a456-426614174000");
    expect(agentSessionRequestSchema.safeParse({ action: "login", password: "secret" }).success).toBe(true);
    expect(agentSessionRequestSchema.safeParse({ action: "status", password: "extra" }).success).toBe(false);
    expect(agentSessionResponseSchema.safeParse({ authenticated: false, epoch }).success).toBe(false);
    expect(agentSessionResponseSchema.safeParse({ authenticated: true, epoch, serverNow: now, retryWindowMs: AGENT_RETRY_WINDOW_MS }).success).toBe(true);
    expect(isCurrentAgentRequestId(requestId, epoch, now)).toBe(true);
    expect(isCurrentAgentRequestId(requestId, epoch, now + AGENT_RETRY_WINDOW_MS)).toBe(false);
    expect(isCurrentAgentRequestId(requestId, "b".repeat(32), now)).toBe(false);
  });

  it("digests validated JSON independent of object key order and negative zero", async () => {
    const reordered = {
      framing: { gimbalPitchDeg: -10, headingDeg: 45, kind: "fixed" },
      heightAboveTakeoffM: -0,
      shot: { anchors: [
        { longitudeDeg: -70, latitudeDeg: 40 },
        { longitudeDeg: -70.001, latitudeDeg: 40.001 },
      ], kind: "route" },
    } satisfies MissionInput;
    const zero = { ...route, heightAboveTakeoffM: 0 };
    expect(canonicalMissionInput(reordered)).toBe(canonicalMissionInput(zero));
    expect(await digestMissionInput(reordered)).toBe(await digestMissionInput(zero));
    expect(await digestMissionInput(route)).not.toBe(await digestMissionInput({ ...route, shot: { ...route.shot, anchors: [...route.shot.anchors].reverse() } }));
    expect(await digestMissionInput(route)).not.toBe(await digestMissionInput({ ...route, heightAboveTakeoffM: 21 }));
    expect(await digestMissionInput(route)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("uses planner validity for snapshots and previews both route and orbit changes", async () => {
    const binding = { missionBranchId: "branch", revision: 1, inputDigest: await digestMissionInput(route), schemaVersion: AGENT_SCHEMA_VERSION, plannerVersion: PLANNER_VERSION };
    const request = { requestId: "request-1", message: "Change the height", snapshot: route, binding };
    expect(agentRequestSchema.safeParse(request).success).toBe(true);
    for (const input of [
      { ...route, extra: true },
      { ...route, heightAboveTakeoffM: Number.POSITIVE_INFINITY },
      { ...orbit, shot: { ...orbit.shot, radiusM: 20_000 } },
    ]) {
      expect(agentRequestSchema.safeParse({ ...request, snapshot: input }).success).toBe(planMission(input).kind === "calculated");
    }
    expect(editorHeightChangeSchema.safeParse({ kind: "set-orbit-radius", radiusM: 50 }).success).toBe(false);
    expect(missionChangeSchema.safeParse({ kind: "set-orbit-radius", radiusM: 50 }).success).toBe(true);
    const routePreview = previewMissionChange(route, { kind: "set-height", heightAboveTakeoffM: 35 });
    expect(routePreview.kind).toBe("valid");
    if (routePreview.kind === "valid") {
      expect(routePreview.candidate.waypoints.map((waypoint) => waypoint.coordinate)).toEqual(route.shot.kind === "route" ? route.shot.anchors : []);
      expect(routePreview.candidate.waypoints.every((waypoint) => waypoint.heightAboveTakeoffM === 35)).toBe(true);
    }
    expect(previewMissionChange(route, { kind: "set-orbit-radius", radiusM: 50 })).toMatchObject({ kind: "invalid", diagnostics: [{ code: "unsupported" }] });
    const orbitPreview = previewMissionChange(orbit, { kind: "set-orbit-radius", radiusM: 50 });
    expect(orbitPreview).toMatchObject({ kind: "valid", candidate: { input: { shot: { radiusM: 50 } } } });
    expect(route.heightAboveTakeoffM).toBe(20);
  });

  it("rejects malformed and oversized request and response metadata", async () => {
    const binding = { missionBranchId: "branch", revision: 1, inputDigest: await digestMissionInput(route), schemaVersion: AGENT_SCHEMA_VERSION, plannerVersion: PLANNER_VERSION };
    const request = { requestId: "request-1", message: "Change the height", snapshot: route, binding };
    expect(agentRequestSchema.safeParse({ ...request, requestId: "" }).success).toBe(false);
    expect(agentRequestSchema.safeParse({ ...request, history: Array.from({ length: 12 }, () => ({ role: "user", content: "x".repeat(2_000) })) }).success).toBe(false);
    expect(agentRequestSchema.safeParse({ ...request, binding: { ...binding, schemaVersion: "x".repeat(65) } }).success).toBe(false);
    expect(agentRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
    const response = { requestId: request.requestId, binding, outcome: { kind: "proposed", change: { kind: "set-height", heightAboveTakeoffM: 35 }, activity: [] } };
    expect(agentResponseSchema.safeParse(response).success).toBe(true);
    for (const outcome of [
      { kind: "answered", text: "The route is ready.", activity: [] },
      { kind: "needs-input", question: "Which height?", activity: [] },
      { kind: "failed", activity: [] },
      { kind: "cancelled", activity: [] },
      { kind: "deadline", activity: [] },
      { kind: "budget-exceeded", activity: [] },
      { kind: "unavailable", activity: [] },
    ]) expect(agentResponseSchema.safeParse({ ...response, outcome }).success).toBe(true);
    expect(agentResponseSchema.safeParse({ ...response, outcome: { ...response.outcome, candidate: route } }).success).toBe(false);
    expect(agentResponseSchema.safeParse({ ...response, outcome: { kind: "failed", activity: [], secret: "provider details" } }).success).toBe(false);
    expect(agentResponseSchema.safeParse({ ...response, outcome: { kind: "answered", text: "x".repeat(4_001), activity: [] } }).success).toBe(false);
  });
});
