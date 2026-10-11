import { describe, expect, expectTypeOf, it } from "vitest";
import * as planner from "../src/index.js";
import type { Coordinate, Framing, InputIssue, MissionInput, PlanResult, Shot, Target, Waypoint } from "../src/index.js";

const point = (latitudeDeg: number, longitudeDeg: number): Coordinate => ({ latitudeDeg, longitudeDeg });
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing item at index ${index}`);
  return item;
};
const coordinateBearing = (coordinate: Coordinate) =>
  (Math.atan2(coordinate.longitudeDeg * 6_378_137, coordinate.latitudeDeg * 6_335_439.3272928195) * 180 / Math.PI + 360) % 360;
const fixed = (headingDeg = 90, gimbalPitchDeg = -20) => ({ kind: "fixed", headingDeg, gimbalPitchDeg });
const route = (anchors: Coordinate[], heightAboveTakeoffM = 40, framing: unknown = fixed()) => ({
  shot: { kind: "route", anchors }, heightAboveTakeoffM, framing,
});
const orbit = (overrides: Record<string, unknown> = {}) => ({
  shot: {
    kind: "orbit", centre: point(0, 0), radiusM: 100, startBearingDeg: 0,
    direction: "clockwise", arc: { kind: "closed" },
    ...overrides,
  },
  heightAboveTakeoffM: 40,
  framing: fixed(),
});
const successful = (value: unknown): readonly Waypoint[] => {
  const result = planner.planMission(value);
  expect(result.kind).toBe("calculated");
  if (result.kind !== "calculated") throw new Error("Expected a calculated plan");
  expect(Object.keys(result).sort()).toEqual(["kind", "waypoints"].sort());
  for (const waypoint of result.waypoints) {
    expect(Object.keys(waypoint).sort()).toEqual(["coordinate", "heightAboveTakeoffM", "headingDeg", "gimbalPitchDeg"].sort());
    expect(Number.isFinite(waypoint.coordinate.latitudeDeg)).toBe(true);
    expect(waypoint.coordinate.latitudeDeg).toBeGreaterThanOrEqual(-90);
    expect(waypoint.coordinate.latitudeDeg).toBeLessThanOrEqual(90);
    expect(Number.isFinite(waypoint.coordinate.longitudeDeg)).toBe(true);
    expect(waypoint.coordinate.longitudeDeg).toBeGreaterThanOrEqual(-180);
    expect(waypoint.coordinate.longitudeDeg).toBeLessThanOrEqual(180);
    expect(Number.isFinite(waypoint.heightAboveTakeoffM)).toBe(true);
    expect(Number.isFinite(waypoint.headingDeg)).toBe(true);
    expect(waypoint.headingDeg).toBeGreaterThanOrEqual(0);
    expect(waypoint.headingDeg).toBeLessThan(360);
    expect(Number.isFinite(waypoint.gimbalPitchDeg)).toBe(true);
    expect(waypoint.gimbalPitchDeg).toBeGreaterThanOrEqual(-90);
    expect(waypoint.gimbalPitchDeg).toBeLessThanOrEqual(90);
  }
  return result.waypoints;
};
const issuesFor = (value: unknown) => {
  const result = planner.planMission(value);
  expect(result.kind).toBe("invalid-input");
  if (result.kind !== "invalid-input") throw new Error("Expected invalid input");
  expect(result.issues.length).toBeGreaterThan(0);
  for (const issue of result.issues) {
    for (const segment of issue.path) expect(typeof segment === "string" || typeof segment === "number").toBe(true);
    expect(issue.code).toMatch(/^(missing|malformed|unsupported)$/);
    expect(issue.message.trim().length).toBeGreaterThan(0);
  }
  return result.issues;
};
const distanceApproxM = (a: Coordinate, b: Coordinate) => {
  const rad = Math.PI / 180;
  const lat = (a.latitudeDeg + b.latitudeDeg) / 2 * rad;
  const north = (b.latitudeDeg - a.latitudeDeg) * rad * 6_371_000;
  const east = (b.longitudeDeg - a.longitudeDeg) * rad * 6_371_000 * Math.cos(lat);
  return Math.hypot(north, east);
};

describe("public planner contract", () => {
  it("exports only the public planning operation at runtime", () => {
    expect(Object.keys(planner)).toEqual(["planMission"]);
    expect(typeof planner.planMission).toBe("function");
  });

  it("retains the public result and waypoint type shapes", () => {
    expectTypeOf<Coordinate>().toEqualTypeOf<Readonly<{ latitudeDeg: number; longitudeDeg: number }>>();
    expectTypeOf<Target>().toEqualTypeOf<Readonly<{ coordinate: Coordinate; heightAboveTakeoffM: number }>>();
    expectTypeOf<Framing>().toEqualTypeOf<Readonly<{ kind: "fixed"; headingDeg: number; gimbalPitchDeg: number }> | Readonly<{ kind: "face-target"; target: Target }>>();
    expectTypeOf<Shot>().toEqualTypeOf<Readonly<{ kind: "route"; anchors: readonly Coordinate[] }> | Readonly<{ kind: "orbit"; centre: Coordinate; radiusM: number; startBearingDeg: number; direction: "clockwise" | "counterclockwise"; arc: Readonly<{ kind: "closed" }> | Readonly<{ kind: "partial"; sweepDeg: number }> }>>();
    expectTypeOf<MissionInput>().toEqualTypeOf<Readonly<{ shot: Shot; heightAboveTakeoffM: number; framing: Framing }>>();
    expectTypeOf<InputIssue>().toEqualTypeOf<Readonly<{ path: readonly (string | number)[]; code: string; message: string }>>();
    expectTypeOf<keyof Waypoint>().toEqualTypeOf<"coordinate" | "heightAboveTakeoffM" | "headingDeg" | "gimbalPitchDeg">();
    expectTypeOf<Extract<PlanResult, { kind: "calculated" }>>().toEqualTypeOf<Readonly<{ kind: "calculated"; waypoints: readonly Waypoint[] }>>();
  });

  it("copies route anchors in order with repeated positions and signed height", () => {
    const anchors = [point(10, 20), point(10, 20), point(-10, 179.9)];
    const waypoints = successful(route(anchors, -3, fixed(359.5, 90)));
    expect(waypoints.map((waypoint) => waypoint.coordinate)).toEqual(anchors);
    expect(waypoints.map((waypoint) => waypoint.heightAboveTakeoffM)).toEqual([-3, -3, -3]);
    expect(waypoints.map(({ headingDeg, gimbalPitchDeg }) => [headingDeg, gimbalPitchDeg])).toEqual([[359.5, 90], [359.5, 90], [359.5, 90]]);
    for (const waypoint of waypoints) {
      expect(Object.keys(waypoint).sort()).toEqual(["coordinate", "gimbalPitchDeg", "headingDeg", "heightAboveTakeoffM"].sort());
    }
    const result = planner.planMission(route(anchors, -3, fixed(359.5, 90)));
    expect(Object.keys(result).sort()).toEqual(["kind", "waypoints"].sort());
  });

  it("accepts the minimum and maximum route sizes without interpolation", () => {
    expect(successful(route([point(0, 0), point(90, 180)])).length).toBe(2);
    const many = Array.from({ length: 100 }, (_, index) => point(index - 50, index));
    expect(successful(route(many)).map(({ coordinate }) => coordinate)).toEqual(many);
  });

  it("allows zero route height and fixed angle endpoints", () => {
    const waypoints = successful(route([point(-90, -180), point(90, 180)], 0, fixed(0, -90)));
    expect(waypoints.map((waypoint) => [waypoint.heightAboveTakeoffM, waypoint.headingDeg, waypoint.gimbalPitchDeg])).toEqual([[0, 0, -90], [0, 0, -90]]);
  });

  it("keeps route geometry exact across the antimeridian and at the poles", () => {
    const anchors = [point(0, 179.9), point(0, -179.999), point(90, -180)];
    expect(successful(route(anchors)).map((waypoint) => waypoint.coordinate)).toEqual(anchors);
  });

  it("creates a closed orbit with exact closure, constant radius, ordered samples, and one-metre chord quality", () => {
    const waypoints = successful(orbit());
    expect(waypoints.length).toBeGreaterThanOrEqual(4);
    expect(waypoints.length).toBeLessThanOrEqual(200);
    expect(waypoints.at(-1)?.coordinate).toEqual(waypoints[0]?.coordinate);
    const centre = point(0, 0);
    const radii = waypoints.slice(0, -1).map(({ coordinate }) => distanceApproxM(centre, coordinate));
    for (const radius of radii) expect(radius).toBeGreaterThan(99);
    for (const radius of radii) expect(radius).toBeLessThan(101);
    const bearings = waypoints.slice(0, -1).map(({ coordinate }) => coordinateBearing(coordinate));
    const segmentCount = bearings.length;
    const maxStep = Math.min(Math.PI / 2, 2 * Math.acos(1 - 1 / 100));
    const expectedCount = Math.ceil(2 * Math.PI / maxStep);
    expect(segmentCount).toBe(expectedCount);
    const spacings = bearings.map((bearing, index) => ((at(bearings, (index + 1) % bearings.length) - bearing + 360) % 360));
    for (const spacing of spacings) expect(spacing).toBeCloseTo(360 / segmentCount, 5);
    expect(100 * (1 - Math.cos((Math.max(...spacings) * Math.PI / 180) / 2))).toBeLessThanOrEqual(1);
  });

  it("places an orbit around a nonzero midlatitude centre", () => {
    const centre = point(45, 10);
    const waypoints = successful(orbit({ centre, radiusM: 100, arc: { kind: "partial", sweepDeg: 90 } }));
    const north = at(waypoints, 0).coordinate;
    const east = at(waypoints, waypoints.length - 1).coordinate;
    expect(north.latitudeDeg).toBeGreaterThan(centre.latitudeDeg);
    expect(north.longitudeDeg).toBeCloseTo(centre.longitudeDeg, 5);
    expect(east.longitudeDeg).toBeGreaterThan(centre.longitudeDeg);
    expect(distanceApproxM(centre, north)).toBeGreaterThan(99);
    expect(distanceApproxM(centre, north)).toBeLessThan(101);
    expect(distanceApproxM(centre, east)).toBeGreaterThan(99);
    expect(distanceApproxM(centre, east)).toBeLessThan(101);
  });

  it("applies fixed and target-facing orientation to every orbit waypoint", () => {
    const fixedWaypoints = successful(orbit({ arc: { kind: "partial", sweepDeg: 90 } }));
    for (const waypoint of fixedWaypoints) expect([waypoint.heightAboveTakeoffM, waypoint.headingDeg, waypoint.gimbalPitchDeg]).toEqual([40, 90, -20]);
    const facing = successful({
      ...orbit({ arc: { kind: "partial", sweepDeg: 90 } }),
      heightAboveTakeoffM: 100,
      framing: { kind: "face-target", target: { coordinate: point(0, 0), heightAboveTakeoffM: 0 } },
    });
    expect(at(facing, 0).headingDeg).toBeCloseTo(180, 5);
    expect(at(facing, 0).gimbalPitchDeg).toBeCloseTo(-45, 5);
    expect(facing.at(-1)?.headingDeg).toBeCloseTo(270, 5);
    expect(facing.at(-1)?.gimbalPitchDeg).toBeCloseTo(-45, 5);
  });

  it("matches an independent WGS84 equatorial orbit coordinate", () => {
    const waypoints = successful(orbit({ radiusM: 100, startBearingDeg: 90, arc: { kind: "partial", sweepDeg: 1 } }));
    const first = at(waypoints, 0).coordinate;
    expect(first.latitudeDeg).toBeCloseTo(0, 10);
    expect(first.longitudeDeg).toBeCloseTo(0.0008983152841195215, 10);
    expect(waypoints.at(-1)?.coordinate.latitudeDeg).toBeLessThan(0);
  });

  it("samples partial clockwise and counterclockwise arcs from exact start through exact end", () => {
    const clockwise = successful(orbit({ startBearingDeg: 350, direction: "clockwise", arc: { kind: "partial", sweepDeg: 20 } }));
    const counter = successful(orbit({ startBearingDeg: 10, direction: "counterclockwise", arc: { kind: "partial", sweepDeg: 20 } }));
    expect(clockwise.length).toBeGreaterThanOrEqual(2);
    expect(counter.length).toBe(clockwise.length);
    expect(at(clockwise, 0).coordinate.longitudeDeg).toBeCloseTo(-100 / 6_378_137 * 180 / Math.PI * Math.sin(10 * Math.PI / 180), 4);
    expect(at(counter, 0).coordinate.longitudeDeg).toBeGreaterThan(0);
    expect(at(clockwise, 0).coordinate.latitudeDeg).toBeCloseTo(0.000889, 5);
    expect(clockwise.at(-1)?.coordinate.latitudeDeg).toBeCloseTo(0.000889, 5);
    expect(at(counter, 0).coordinate.latitudeDeg).toBeCloseTo(0.000889, 5);
    expect(counter.at(-1)?.coordinate.latitudeDeg).toBeCloseTo(0.000889, 5);
    expect(clockwise.at(-1)?.coordinate).not.toEqual(clockwise[0]?.coordinate);
  });

  it("closes a counterclockwise orbit and reaches exact partial cardinal endpoints", () => {
    const closed = successful(orbit({ direction: "counterclockwise", startBearingDeg: 45 }));
    expect(closed.at(-1)?.coordinate).toEqual(closed[0]?.coordinate);
    const bearings = closed.slice(0, -1).map(({ coordinate }) => coordinateBearing(coordinate));
    expect(((at(bearings, 0) - at(bearings, 1) + 360) % 360)).toBeCloseTo(360 / (closed.length - 1), 5);
    const eastEnd = successful(orbit({ startBearingDeg: 0, arc: { kind: "partial", sweepDeg: 90 } })).at(-1)?.coordinate;
    expect(eastEnd?.latitudeDeg).toBeCloseTo(0, 8);
    expect(eastEnd?.longitudeDeg).toBeCloseTo(0.0008983152841195215, 10);
    const westEnd = successful(orbit({ startBearingDeg: 0, direction: "counterclockwise", arc: { kind: "partial", sweepDeg: 90 } })).at(-1)?.coordinate;
    expect(westEnd?.latitudeDeg).toBeCloseTo(0, 8);
    expect(westEnd?.longitudeDeg).toBeCloseTo(-0.0008983152841195215, 10);
  });

  it("handles wrapped partial arcs, polar centres, and tiny radii with finite samples", () => {
    for (const input of [
      orbit({ startBearingDeg: 340, arc: { kind: "partial", sweepDeg: 35 } }),
      { ...orbit({ centre: point(90, 0), radiusM: 5, arc: { kind: "partial", sweepDeg: 30 } }) },
      orbit({ radiusM: 1e-9, arc: { kind: "partial", sweepDeg: 300 } }),
      orbit({ radiusM: 1e-9, arc: { kind: "closed" } }),
      orbit({ centre: point(0, 179.9995), radiusM: 100, startBearingDeg: 90, arc: { kind: "partial", sweepDeg: 30 } }),
    ]) {
      const waypoints = successful(input);
      if (input.shot.centre.latitudeDeg === 0 && input.shot.centre.longitudeDeg === 179.9995) {
        expect(at(waypoints, 0).coordinate.longitudeDeg).toBeLessThan(-179.999);
      }
      if (input.shot.radiusM === 1e-9) expect(waypoints).toHaveLength(5);
      expect(waypoints.length).toBeGreaterThanOrEqual(2);
      for (const waypoint of waypoints) {
        expect(Number.isFinite(waypoint.coordinate.latitudeDeg)).toBe(true);
        expect(Number.isFinite(waypoint.coordinate.longitudeDeg)).toBe(true);
      }
    }
  });

  it("keeps one segment for the smallest positive partial sweep", () => {
    const waypoints = successful(orbit({ radiusM: 100, arc: { kind: "partial", sweepDeg: Number.MIN_VALUE } }));
    expect(waypoints.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts exact 10 km orbit-to-centre framing across difficult centres", () => {
    const centres = [point(-70, 0), point(45, -179.999), point(89, 10)];
    const results = centres.map((centre) => planner.planMission({
      ...orbit({ centre, radiusM: 10_000, startBearingDeg: 0, arc: { kind: "partial", sweepDeg: 1 } }),
      heightAboveTakeoffM: 40,
      framing: { kind: "face-target", target: { coordinate: centre, heightAboveTakeoffM: 0 } },
    }));
    expect(results.map(({ kind }) => kind)).toEqual(["calculated", "calculated", "calculated"]);
    for (const result of results) {
      if (result.kind !== "calculated") throw new Error("Expected a calculated plan");
      expect(result.waypoints).toHaveLength(2);
      for (const waypoint of result.waypoints) {
        expect(Number.isFinite(waypoint.headingDeg)).toBe(true);
        expect(Number.isFinite(waypoint.gimbalPitchDeg)).toBe(true);
      }
    }
  });

  it("rejects orbit radii beyond its local domain and sample cap without degrading quality", () => {
    const tooWide = issuesFor(orbit({ radiusM: 10_001 }));
    expect(tooWide.some(({ code, path }) => code === "unsupported" && path.join(".") === "shot.radiusM")).toBe(true);
    const hugeRadius = issuesFor(orbit({ radiusM: Number.MAX_VALUE }));
    expect(hugeRadius.some(({ code, path }) => code === "unsupported" && path.join(".") === "shot.radiusM")).toBe(true);
    const atSampleCap = successful(orbit({ radiusM: 8_025.006055585453, arc: { kind: "closed" } }));
    expect(atSampleCap).toHaveLength(200);
    const exactSampleBoundary = successful(orbit({ radiusM: 8_025.007055585453, arc: { kind: "closed" } }));
    expect(exactSampleBoundary).toHaveLength(200);
    const overSamples = issuesFor(orbit({ radiusM: 8_025.008055585453, arc: { kind: "closed" } }));
    expect(overSamples.some(({ code, path }) => code === "unsupported" && path.includes("radiusM"))).toBe(true);
    expect(successful(orbit({ radiusM: 10_000, arc: { kind: "partial", sweepDeg: 1 } })).length).toBeLessThanOrEqual(200);
  });

  it("faces targets in all cardinal quadrants and normalizes bearings", () => {
    const cases: readonly [Coordinate, Coordinate, number][] = [
      [point(0, 0), point(0, 0.001), 90],
      [point(0, 0), point(0.001, 0), 0],
      [point(0, 0), point(0, -0.001), 270],
      [point(0, 0), point(-0.001, 0), 180],
    ];
    for (const [origin, target, expected] of cases) {
      const waypoints = successful(route([origin, point(origin.latitudeDeg, origin.longitudeDeg + 0.01)], 0, { kind: "face-target", target: { coordinate: target, heightAboveTakeoffM: 0 } }));
      expect(at(waypoints, 0).headingDeg).toBeCloseTo(expected, 3);
      expect(at(waypoints, 0).headingDeg).toBeGreaterThanOrEqual(0);
      expect(at(waypoints, 0).headingDeg).toBeLessThan(360);
    }
  });

  it("computes level, upward, and downward pitch from the caller height datum", () => {
    const target = { coordinate: point(0, 0.0008983152841195215), heightAboveTakeoffM: 10 };
    const frame = { kind: "face-target", target };
    const up = successful(route([point(0, 0), point(0, 0.001)], 110, frame));
    const down = successful(route([point(0, 0), point(0, 0.001)], -90, frame));
    const level = successful(route([point(0, 0), point(0, 0.001)], 10, frame));
    expect(at(level, 0).gimbalPitchDeg).toBeCloseTo(0, 8);
    expect(at(up, 0).gimbalPitchDeg).toBeLessThan(0);
    expect(at(down, 0).gimbalPitchDeg).toBeGreaterThan(0);
    expect(at(up, 0).gimbalPitchDeg).toBeCloseTo(-45, 4);
    expect(at(down, 0).gimbalPitchDeg).toBeCloseTo(45, 4);
  });

  it("normalizes target-facing bearings across the antimeridian", () => {
    const waypoints = successful(route([point(0, 179.999), point(0, 179.998)], 0, { kind: "face-target", target: { coordinate: point(0, -179.999), heightAboveTakeoffM: 0 } }));
    expect(at(waypoints, 0).headingDeg).toBeCloseTo(90, 4);
    expect(at(waypoints, 0).gimbalPitchDeg).toBeCloseTo(0, 8);
  });

  it("rejects coincident target points, including pole and longitude aliases", () => {
    const cases: readonly [Coordinate, Coordinate, Coordinate][] = [
      [point(12, 30), point(12.001, 30), point(12, 30)],
      [point(90, 0), point(89.999, 0), point(90, 180)],
      [point(0, -180), point(0.001, -180), point(0, 180)],
    ];
    for (const [origin, nearby, target] of cases) {
      const issues = issuesFor(route([origin, nearby], 0, { kind: "face-target", target: { coordinate: target, heightAboveTakeoffM: 0 } }));
      expect(issues.some(({ code, path }) => code === "unsupported" && path.includes("coordinate"))).toBe(true);
    }
  });

  it("accepts target separation above one micrometre and rejects it below", () => {
    const origin = point(0, 0);
    const targetAt = (longitudeDeg: number) => ({ kind: "face-target", target: { coordinate: point(0, longitudeDeg), heightAboveTakeoffM: 0 } });
    const above = successful(route([origin, point(0, 0.01)], 0, targetAt(2e-6 / 111_319.49079327358)));
    expect(Number.isFinite(at(above, 0).headingDeg)).toBe(true);
    const below = issuesFor(route([origin, point(0, 0.01)], 0, targetAt(0.5e-6 / 111_319.49079327358)));
    expect(below.some(({ code, path }) => code === "unsupported" && path.includes("coordinate"))).toBe(true);
  });

  it("rejects target-facing at exact poles and beyond the local target range", () => {
    const pole = issuesFor(route([point(90, 0), point(89.999, 0)], 0, { kind: "face-target", target: { coordinate: point(89.9995, 0), heightAboveTakeoffM: 0 } }));
    expect(pole.some(({ code, path }) => code === "unsupported" && path.includes("coordinate"))).toBe(true);
    const withinRange = successful(route([point(0, 0), point(0, 0.001)], 0, { kind: "face-target", target: { coordinate: point(0, 0.08983152841195215), heightAboveTakeoffM: 0 } }));
    expect(withinRange).toHaveLength(2);
    const far = issuesFor(route([point(0, 0), point(0, 0.001)], 0, { kind: "face-target", target: { coordinate: point(0, 0.08983161824295215), heightAboveTakeoffM: 0 } }));
    expect(far.some(({ code, path }) => code === "unsupported" && path.includes("coordinate"))).toBe(true);
  });

  it("rejects the whole result when any waypoint has undefined orientation", () => {
    const result = planner.planMission(route([point(0, 0), point(0, 0.01)], 0, { kind: "face-target", target: { coordinate: point(0, 0.01), heightAboveTakeoffM: 0 } }));
    expect(result.kind).toBe("invalid-input");
    if (result.kind === "calculated") throw new Error("Expected an invalid plan with no waypoints");
    expect("waypoints" in result).toBe(false);
    expect(result.issues.some(({ code, path }) => code === "unsupported" && path.includes("coordinate"))).toBe(true);
  });

  it("keeps angles finite for opposite extreme finite heights", () => {
    const waypoints = successful(route([point(0, 0), point(0, 0.01)], -Number.MAX_VALUE, { kind: "face-target", target: { coordinate: point(0, 0.02), heightAboveTakeoffM: Number.MAX_VALUE } }));
    for (const waypoint of waypoints) {
      expect(Number.isFinite(waypoint.headingDeg)).toBe(true);
      expect(Number.isFinite(waypoint.gimbalPitchDeg)).toBe(true);
      expect(waypoint.gimbalPitchDeg).toBeGreaterThanOrEqual(-90);
      expect(waypoint.gimbalPitchDeg).toBeLessThanOrEqual(90);
    }
  });

  it("returns deterministic structured issues for malformed request shapes", () => {
    const invalid: unknown[] = [undefined, null, 3, "route", [], {}, { shot: null }, { shot: [], heightAboveTakeoffM: 0, framing: fixed() }, { shot: { kind: "route", anchors: [point(0, 0)] }, heightAboveTakeoffM: 0, framing: fixed() }];
    for (const input of invalid) {
      const first = issuesFor(input);
      expect(planner.planMission(input)).toEqual({ kind: "invalid-input", issues: first });
    }
  });

  it("distinguishes missing required fields from malformed null or wrong types", () => {
    const rootMissing = issuesFor(undefined);
    expect(rootMissing.some(({ code, path }) => code === "missing" && path.length === 0)).toBe(true);
    const missing = issuesFor({ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, framing: fixed() });
    expect(missing.some(({ code, path }) => code === "missing" && path.includes("heightAboveTakeoffM"))).toBe(true);
    const malformed = issuesFor({ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: null, framing: fixed() });
    expect(malformed.some(({ code, path }) => code === "malformed" && path.includes("heightAboveTakeoffM"))).toBe(true);
  });

  it("rejects unsupported enums, extra legacy fields, and route count violations", () => {
    const cases: readonly [unknown, string][] = [
      [{ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: { kind: "fixed", headingDeg: 0, gimbalPitchDeg: 0, speedMps: 4 } }, "malformed"],
      [{ shot: { kind: "route", anchors: [{ latitudeDeg: 0, longitudeDeg: 0, extra: true }, point(1, 1)] }, heightAboveTakeoffM: 0, framing: fixed() }, "malformed"],
      [{ shot: { kind: "orbit", centre: { latitudeDeg: 0, longitudeDeg: 0, extra: true }, radiusM: 10, startBearingDeg: 0, direction: "clockwise", arc: { kind: "closed" } }, heightAboveTakeoffM: 0, framing: fixed() }, "malformed"],
      [{ shot: { kind: "orbit", centre: point(0, 0), radiusM: 10, startBearingDeg: 0, direction: "clockwise", arc: { kind: "closed", extra: true } }, heightAboveTakeoffM: 0, framing: fixed() }, "malformed"],
      [{ shot: { kind: "route", anchors: [point(0, 0), point(0, 0.001)] }, heightAboveTakeoffM: 0, framing: { kind: "face-target", target: { coordinate: point(0.002, 0.002), heightAboveTakeoffM: 0, extra: true } } }, "malformed"],
      [{ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: fixed(), mission: {} }, "malformed"],
      [{ shot: { kind: "route", anchors: [point(0, 0)] }, heightAboveTakeoffM: 0, framing: fixed() }, "malformed"],
      [{ shot: { kind: "route", anchors: [] }, heightAboveTakeoffM: 0, framing: fixed() }, "malformed"],
      [{ shot: { kind: "route", anchors: Array(2) }, heightAboveTakeoffM: 0, framing: fixed() }, "missing"],
      [{ shot: { kind: "route", anchors: Array.from({ length: 101 }, (_, index) => point(0, index)) }, heightAboveTakeoffM: 0, framing: fixed() }, "unsupported"],
      [{ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0 }, "missing"],
      [{ shot: { anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: fixed() }, "missing"],
      [{ shot: { kind: "unknown", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: fixed() }, "malformed"],
      [{ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: { kind: "unknown" } }, "malformed"],
      [{ shot: { kind: "orbit", centre: point(0, 0), radiusM: 10, startBearingDeg: 0, direction: "clockwise", arc: { kind: "unknown" } }, heightAboveTakeoffM: 0, framing: fixed() }, "malformed"],
      [{ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: { kind: "face-target", target: { coordinate: {}, heightAboveTakeoffM: 0 } } }, "missing"],
      [{ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: { kind: "face-target", target: { coordinate: null, heightAboveTakeoffM: 0 } } }, "malformed"],
      [{ shot: { kind: "orbit", centre: point(0, 0), radiusM: 10, startBearingDeg: 0, direction: "clockwise", arc: { kind: "partial" } }, heightAboveTakeoffM: 0, framing: fixed() }, "missing"],
      [{ shot: { kind: "route", anchors: [point(0, 0), point(1, 1)] }, heightAboveTakeoffM: 0, framing: { kind: "face-target", target: {} } }, "missing"],
      [orbit({ arc: null }), "malformed"],
      [{ shot: { kind: "orbit", centre: {}, radiusM: 10, startBearingDeg: 0, direction: "clockwise", arc: { kind: "closed" } }, heightAboveTakeoffM: 0, framing: fixed() }, "missing"],
      [orbit({ direction: "north" }), "malformed"],
      [orbit({ arc: { kind: "partial", sweepDeg: 360 } }), "malformed"],
      [orbit({ arc: { kind: "closed", sweepDeg: 2 } }), "malformed"],
    ];
    for (const [input, expectedCode] of cases) expect(issuesFor(input).some(({ code }) => code === expectedCode), JSON.stringify({ input, expectedCode })).toBe(true);
  });

  it("reports missing diagnostics at both sparse or undefined anchor positions", () => {
    for (const anchors of [new Array<unknown>(2), [undefined, undefined]]) {
      const issues = issuesFor({ shot: { kind: "route", anchors }, heightAboveTakeoffM: 0, framing: fixed() });
      for (const index of [0, 1]) {
        expect(issues).toContainEqual(expect.objectContaining({
          code: "missing",
          path: ["shot", "anchors", index],
        }));
      }
    }
  });

  it("rejects invalid coordinate, angle, radius, sweep, and height ranges", () => {
    const invalid: unknown[] = [
      route([point(90.01, 0), point(0, 0)]), route([point(0, -180.01), point(0, 0)]),
      route([point(0, 0), point(0, 0)], Number.NaN), route([point(0, 0), point(0, 0)], Number.POSITIVE_INFINITY),
      { ...route([point(0, 0), point(1, 1)]), framing: { kind: "fixed", headingDeg: 360, gimbalPitchDeg: 0 } },
      { ...route([point(0, 0), point(1, 1)]), framing: { kind: "fixed", headingDeg: -0.01, gimbalPitchDeg: 0 } },
      { ...route([point(0, 0), point(1, 1)]), framing: { kind: "fixed", headingDeg: 0, gimbalPitchDeg: -90.01 } },
      { ...route([point(0, 0), point(1, 1)]), framing: { kind: "fixed", headingDeg: 0, gimbalPitchDeg: 90.01 } },
      orbit({ radiusM: 0 }), orbit({ radiusM: -1 }), orbit({ radiusM: Number.MAX_VALUE }),
      orbit({ startBearingDeg: 360 }), orbit({ startBearingDeg: -0.01 }),
      orbit({ arc: { kind: "partial", sweepDeg: 0 } }), orbit({ arc: { kind: "partial", sweepDeg: -1 } }),
      route([point(-90.01, 0), point(0, 0)]), route([point(0, 180.01), point(0, 0)]),
    ];
    for (const input of invalid) expect(issuesFor(input).length).toBeGreaterThan(0);
  });

  it("rejects every non-finite numeric field at its exact path", () => {
    const fields: readonly { path: readonly (string | number)[]; build: (value: number) => unknown }[] = [
      { path: ["shot", "anchors", 0, "latitudeDeg"], build: (value) => route([point(value, 0), point(1, 1)]) },
      { path: ["shot", "anchors", 0, "longitudeDeg"], build: (value) => route([point(0, value), point(1, 1)]) },
      { path: ["heightAboveTakeoffM"], build: (value) => route([point(0, 0), point(1, 1)], value) },
      { path: ["framing", "headingDeg"], build: (value) => route([point(0, 0), point(1, 1)], 0, fixed(value, 0)) },
      { path: ["framing", "gimbalPitchDeg"], build: (value) => route([point(0, 0), point(1, 1)], 0, fixed(0, value)) },
      { path: ["shot", "centre", "latitudeDeg"], build: (value) => orbit({ centre: point(value, 0) }) },
      { path: ["shot", "centre", "longitudeDeg"], build: (value) => orbit({ centre: point(0, value) }) },
      { path: ["shot", "radiusM"], build: (value) => orbit({ radiusM: value }) },
      { path: ["shot", "startBearingDeg"], build: (value) => orbit({ startBearingDeg: value }) },
      { path: ["shot", "arc", "sweepDeg"], build: (value) => orbit({ arc: { kind: "partial", sweepDeg: value } }) },
      { path: ["framing", "target", "coordinate", "latitudeDeg"], build: (value) => route([point(0, 0), point(0, 0.001)], 0, { kind: "face-target", target: { coordinate: point(value, 0), heightAboveTakeoffM: 0 } }) },
      { path: ["framing", "target", "coordinate", "longitudeDeg"], build: (value) => route([point(0, 0), point(0, 0.001)], 0, { kind: "face-target", target: { coordinate: point(0, value), heightAboveTakeoffM: 0 } }) },
      { path: ["framing", "target", "heightAboveTakeoffM"], build: (value) => route([point(0, 0), point(0, 0.001)], 0, { kind: "face-target", target: { coordinate: point(0, 0.001), heightAboveTakeoffM: value } }) },
    ];
    for (const field of fields) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const issues = issuesFor(field.build(value));
        expect(issues.some((issue) => issue.code === "malformed" && issue.path.join(".") === field.path.join("."))).toBe(true);
      }
    }
  });

  it("does not coerce numeric strings or accept wrong nested shapes", () => {
    const invalid: unknown[] = [
      { shot: { kind: "route", anchors: [point(0, 0), { latitudeDeg: "1", longitudeDeg: 1 }] }, heightAboveTakeoffM: 0, framing: fixed() },
      { ...route([point(0, 0), point(1, 1)]), framing: { kind: "face-target", target: null } },
      { shot: { kind: "route", anchors: {} }, heightAboveTakeoffM: 0, framing: fixed() },
      { shot: { kind: "route", anchors: [point(0, 0), point(1, 1)], extra: true }, heightAboveTakeoffM: 0, framing: fixed() },
    ];
    for (const input of invalid) expect(issuesFor(input).length).toBeGreaterThan(0);
  });

  it("is pure for frozen input and does not alias caller coordinates", () => {
    const input = Object.freeze({
      shot: Object.freeze({ kind: "route", anchors: Object.freeze([Object.freeze(point(1, 2)), Object.freeze(point(3, 4))]) }),
      heightAboveTakeoffM: 5,
      framing: Object.freeze(fixed(12, -8)),
    });
    const before = JSON.stringify(input);
    const first = successful(input);
    const second = successful(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(at(first, 0).coordinate).not.toBe(at(input.shot.anchors, 0));
  });

  it("keeps a frozen orbit face-target input deterministic and unaliased", () => {
    const centre = Object.freeze(point(0, 0));
    const input = Object.freeze({
      shot: Object.freeze({ kind: "orbit", centre, radiusM: 100, startBearingDeg: 0, direction: "clockwise", arc: Object.freeze({ kind: "partial", sweepDeg: 30 }) }),
      heightAboveTakeoffM: 100,
      framing: Object.freeze({ kind: "face-target", target: Object.freeze({ coordinate: centre, heightAboveTakeoffM: 0 }) }),
    });
    const before = JSON.stringify(input);
    const first = successful(input);
    const second = successful(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(at(first, 0).coordinate).not.toBe(centre);
    expect(at(first, 0).coordinate).not.toBe(at(second, 0).coordinate);
  });

  it("keeps output state independent between calls and from the input", () => {
    const input = route([point(1, 2), point(3, 4)]);
    const first = successful(input);
    const second = successful(input);
    expect(first).toEqual(second);
    expect(at(first, 0).coordinate).not.toBe(at(second, 0).coordinate);
    Reflect.set(at(first, 0).coordinate, "latitudeDeg", 55);
    expect(at(second, 0).coordinate.latitudeDeg).toBe(1);
    expect(at(input.shot.anchors, 0).latitudeDeg).toBe(1);
  });
});
