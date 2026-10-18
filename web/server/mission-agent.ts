import type { MissionInput } from "@drone/mission-planner";

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
