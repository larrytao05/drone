import { describe, expect, expectTypeOf, it } from "vitest";
import * as planner from "../src/index.js";
import type { MissionInput, PlanResult, Waypoint } from "../src/index.js";

const orbitInput = {
  shot: {
    kind: "orbit",
    centre: { latitudeDeg: 37.8, longitudeDeg: -122.4 },
    radiusM: 30,
    startBearingDeg: 0,
    direction: "clockwise",
    arc: { kind: "closed" },
  },
  heightAboveTakeoffM: 40,
  framing: {
    kind: "fixed",
    headingDeg: 90,
    gimbalPitchDeg: -20,
  },
} satisfies MissionInput;

const routeInput = {
  shot: {
    kind: "route",
    anchors: [
      { latitudeDeg: 37.8, longitudeDeg: -122.4 },
      { latitudeDeg: 37.8005, longitudeDeg: -122.4 },
    ],
  },
  heightAboveTakeoffM: 40,
  framing: {
    kind: "face-target",
    target: {
      coordinate: { latitudeDeg: 37.801, longitudeDeg: -122.4 },
      heightAboveTakeoffM: 20,
    },
  },
} satisfies MissionInput;

describe("planner placeholder contract", () => {
  it("exports only the public planning operation at runtime", () => {
    expect(Object.keys(planner)).toEqual(["planMission"]);
    expect(typeof planner.planMission).toBe("function");
  });

  it("keeps the orbit calculation unimplemented", () => {
    expect(() => planner.planMission(orbitInput)).toThrowError(
      new Error("Not implemented"),
    );
  });

  it("keeps the route calculation unimplemented", () => {
    expect(() => planner.planMission(routeInput)).toThrowError(
      new Error("Not implemented"),
    );
  });

  it("keeps the waypoint type to four fields and the result to waypoints", () => {
    expectTypeOf<keyof Waypoint>().toEqualTypeOf<
      | "coordinate"
      | "heightAboveTakeoffM"
      | "headingDeg"
      | "gimbalPitchDeg"
    >();
    expectTypeOf<Extract<PlanResult, { kind: "calculated" }>>().toEqualTypeOf<
      Readonly<{
        kind: "calculated";
        waypoints: readonly Waypoint[];
      }>
    >();
  });
});
