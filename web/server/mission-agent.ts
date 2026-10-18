import { planMission, type MissionInput, type Waypoint } from "@drone/mission-planner";
import { z } from "zod";

export const missionChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set-height"), heightAboveTakeoffM: z.number().finite() }),
  z.strictObject({ kind: z.literal("set-orbit-radius"), radiusM: z.number().finite().positive() }),
]);
export type MissionChange = z.infer<typeof missionChangeSchema>;
export type MissionCandidate = Readonly<{ input: MissionInput; waypoints: readonly Waypoint[] }>;

export function isMissionInput(value: unknown): value is MissionInput {
  return planMission(value).kind === "calculated";
}

export function describeMission(input: MissionInput): unknown {
  const shot = input.shot.kind === "orbit"
    ? {
        kind: "orbit",
        radiusM: input.shot.radiusM,
        startBearingDeg: input.shot.startBearingDeg,
        direction: input.shot.direction,
        arc: input.shot.arc,
      }
    : { kind: "route", anchorCount: input.shot.anchors.length };
  const framing = input.framing.kind === "fixed"
    ? { kind: "fixed", headingDeg: input.framing.headingDeg, gimbalPitchDeg: input.framing.gimbalPitchDeg }
    : { kind: "face-target", targetHeightAboveTakeoffM: input.framing.target.heightAboveTakeoffM };
  return { shot, heightAboveTakeoffM: input.heightAboveTakeoffM, framing };
}

export function previewMissionChange(
  input: MissionInput,
  change: MissionChange,
): { kind: "valid"; candidate: MissionCandidate; summary: unknown } | { kind: "invalid"; diagnostics: unknown } {
  let candidateInput: MissionInput;
  if (change.kind === "set-height") {
    candidateInput = { ...input, heightAboveTakeoffM: change.heightAboveTakeoffM };
  } else {
    if (input.shot.kind !== "orbit") {
      return {
        kind: "invalid",
        diagnostics: [{ path: ["shot", "radiusM"], code: "unsupported", message: "Orbit radius applies only to orbit missions." }],
      };
    }
    candidateInput = { ...input, shot: { ...input.shot, radiusM: change.radiusM } };
  }
  const result = planMission(candidateInput);
  if (result.kind === "invalid-input") {
    return {
      kind: "invalid",
      diagnostics: result.issues.map(({ path, code, message }) => ({ path, code, message })),
    };
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
