import { z } from "zod";
import { missionChangeSchema } from "@drone/mission-planner/agent-contract";
import type { MissionInput } from "@drone/mission-planner";

const jsonNumberLiteral = z.string().max(64).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/).refine((value) => value.trim() === value).transform(Number);
const [heightChange, radiusChange] = missionChangeSchema.options;

export const modelMissionChangeSchema = z.discriminatedUnion("kind", [
  heightChange.extend({ heightAboveTakeoffM: z.union([heightChange.shape.heightAboveTakeoffM, jsonNumberLiteral.pipe(heightChange.shape.heightAboveTakeoffM)]) }),
  radiusChange.extend({ radiusM: z.union([radiusChange.shape.radiusM, jsonNumberLiteral.pipe(radiusChange.shape.radiusM)]) }),
]).pipe(missionChangeSchema);

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
