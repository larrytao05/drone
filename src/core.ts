import geographiclib from "geographiclib-geodesic";
import { z } from "zod";

const { Geodesic } = geographiclib;

const coordinateSchema = z.object({
  latitudeDeg: z.number().finite().min(-90).max(90),
  longitudeDeg: z.number().finite().min(-180).max(180),
}).strict();

const targetSchema = z.object({
  coordinate: coordinateSchema,
  heightAboveTakeoffM: z.number().finite(),
}).strict();

const framingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fixed"),
    headingDeg: z.number().finite().min(0).lt(360),
    gimbalPitchDeg: z.number().finite().min(-90).max(90),
  }).strict(),
  z.object({ kind: z.literal("face-target"), target: targetSchema }).strict(),
]);

const closedArcSchema = z.object({ kind: z.literal("closed") }).strict();
const partialArcSchema = z.object({
  kind: z.literal("partial"),
  sweepDeg: z.number().finite().gt(0).lt(360),
}).strict();

const shotSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("orbit"),
    centre: coordinateSchema,
    radiusM: z.number().finite().gt(0),
    startBearingDeg: z.number().finite().min(0).lt(360),
    direction: z.enum(["clockwise", "counterclockwise"]),
    arc: z.discriminatedUnion("kind", [closedArcSchema, partialArcSchema]),
  }).strict(),
  z.object({ kind: z.literal("route"), anchors: z.array(coordinateSchema) }).strict(),
]);

const missionInputSchema = z.object({
  shot: shotSchema,
  heightAboveTakeoffM: z.number().finite(),
  framing: framingSchema,
}).strict();

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type Coordinate = DeepReadonly<z.infer<typeof coordinateSchema>>;
export type Target = DeepReadonly<z.infer<typeof targetSchema>>;
export type Framing = DeepReadonly<z.infer<typeof framingSchema>>;
export type Shot = DeepReadonly<z.infer<typeof shotSchema>>;
export type MissionInput = DeepReadonly<z.infer<typeof missionInputSchema>>;

export type Waypoint = Readonly<{
  coordinate: Coordinate;
  heightAboveTakeoffM: number;
  headingDeg: number;
  gimbalPitchDeg: number;
}>;

export type InputIssue = Readonly<{
  path: readonly (string | number)[];
  code: string;
  message: string;
}>;

export type PlanResult =
  | Readonly<{ kind: "calculated"; waypoints: readonly Waypoint[] }>
  | Readonly<{ kind: "invalid-input"; issues: readonly InputIssue[] }>;

type ParsedMissionInput = z.infer<typeof missionInputSchema>;
type ParsedCoordinate = z.infer<typeof coordinateSchema>;
type ParsedFraming = z.infer<typeof framingSchema>;
type ParsedShot = z.infer<typeof shotSchema>;

const MAX_ROUTE_ANCHORS = 100;
const MAX_ORBIT_RADIUS_M = 10_000;
const MAX_WAYPOINTS = 200;
const MAX_TARGET_RANGE_M = 10_000;
const MIN_TARGET_DISTANCE_M = 1e-6;

function invalid(issues: readonly InputIssue[]): PlanResult {
  return { kind: "invalid-input", issues };
}

function issue(path: readonly (string | number)[], code: string, message: string): InputIssue {
  return { path, code, message };
}

function parseIssues(error: z.ZodError): InputIssue[] {
  return error.issues.map((problem) => issue(
    problem.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
    problem.input === undefined || (
      problem.code === "invalid_union" &&
      problem.path.at(-1) === "kind" &&
      typeof problem.input === "object" &&
      problem.input !== null
      && Object.getOwnPropertyDescriptor(problem.input, "kind")?.value === undefined
    ) ? "missing" : "malformed",
    problem.message,
  ));
}

function normalizeBearing(degrees: number): number {
  const bearing = ((degrees % 360) + 360) % 360;
  return bearing === 360 ? 0 : bearing;
}

function routeCoordinates(shot: Extract<ParsedShot, { kind: "route" }>): ParsedCoordinate[] {
  return shot.anchors.map(({ latitudeDeg, longitudeDeg }) => ({ latitudeDeg, longitudeDeg }));
}

function orbitSampleCount(shot: Extract<ParsedShot, { kind: "orbit" }>): number | undefined {
  const sweepRadians = shot.arc.kind === "closed" ? 2 * Math.PI : shot.arc.sweepDeg * Math.PI / 180;
  let segments = Math.max(1, Math.ceil(sweepRadians / (Math.PI / 2)));

  while (segments < MAX_WAYPOINTS) {
    const chordDeviation = shot.radiusM * (1 - Math.cos(sweepRadians / (2 * segments)));
    if (chordDeviation <= 1) return segments + 1;
    segments += 1;
  }

  return undefined;
}

function orbitCoordinates(shot: Extract<ParsedShot, { kind: "orbit" }>, count: number): ParsedCoordinate[] {
  const segments = count - 1;
  const sweep = shot.arc.kind === "closed" ? 360 : shot.arc.sweepDeg;
  const direction = shot.direction === "clockwise" ? 1 : -1;
  const points: ParsedCoordinate[] = [];

  for (let index = 0; index < segments; index += 1) {
    const bearing = shot.startBearingDeg + direction * sweep * index / segments;
    const position = Geodesic.WGS84.Direct(
      shot.centre.latitudeDeg,
      shot.centre.longitudeDeg,
      bearing,
      shot.radiusM,
    );
    if (position.lat2 === undefined || position.lon2 === undefined || !Number.isFinite(position.lat2) || !Number.isFinite(position.lon2)) {
      return [];
    }
    points.push({ latitudeDeg: position.lat2, longitudeDeg: position.lon2 });
  }

  if (shot.arc.kind === "closed") {
    const first = points[0];
    if (first === undefined) return [];
    points.push({ latitudeDeg: first.latitudeDeg, longitudeDeg: first.longitudeDeg });
    return points;
  }

  const endBearing = shot.startBearingDeg + direction * sweep;
  const endPosition = Geodesic.WGS84.Direct(
    shot.centre.latitudeDeg,
    shot.centre.longitudeDeg,
    endBearing,
    shot.radiusM,
  );
  if (endPosition.lat2 === undefined || endPosition.lon2 === undefined || !Number.isFinite(endPosition.lat2) || !Number.isFinite(endPosition.lon2)) {
    return [];
  }
  points.push({ latitudeDeg: endPosition.lat2, longitudeDeg: endPosition.lon2 });
  return points;
}

function framingForWaypoint(
  coordinate: ParsedCoordinate,
  heightAboveTakeoffM: number,
  framing: ParsedFraming,
): { headingDeg: number; gimbalPitchDeg: number } | InputIssue {
  if (framing.kind === "fixed") {
    return { headingDeg: framing.headingDeg, gimbalPitchDeg: framing.gimbalPitchDeg };
  }

  const target = framing.target;
  if (Math.abs(coordinate.latitudeDeg) === 90) {
    return issue(["framing", "target", "coordinate"], "unsupported", "Target-facing heading is undefined at a geographic pole.");
  }

  const inverse = Geodesic.WGS84.Inverse(
    coordinate.latitudeDeg,
    coordinate.longitudeDeg,
    target.coordinate.latitudeDeg,
    target.coordinate.longitudeDeg,
  );
  const distance = inverse.s12;
  const azimuth = inverse.azi1;
  if (distance === undefined || azimuth === undefined || distance <= MIN_TARGET_DISTANCE_M || distance > MAX_TARGET_RANGE_M + 1e-6) {
    return issue(["framing", "target", "coordinate"], "unsupported", "Target distance must be greater than one micrometre and at most 10000 metres.");
  }

  const pitch = Math.atan2(target.heightAboveTakeoffM - heightAboveTakeoffM, distance) * 180 / Math.PI;
  const heading = normalizeBearing(azimuth);
  if (!Number.isFinite(pitch) || !Number.isFinite(heading)) {
    return issue(["framing", "target", "coordinate"], "unsupported", "Target orientation could not be calculated as a finite angle.");
  }
  return { headingDeg: heading, gimbalPitchDeg: pitch };
}

function calculate(input: ParsedMissionInput): PlanResult {
  const issues: InputIssue[] = [];
  let coordinates: ParsedCoordinate[];

  if (input.shot.kind === "route") {
    if (input.shot.anchors.length < 2) {
      issues.push(issue(["shot", "anchors"], "malformed", "A route requires at least two anchors."));
    }
    if (input.shot.anchors.length > MAX_ROUTE_ANCHORS) {
      issues.push(issue(["shot", "anchors"], "unsupported", "A route supports at most 100 anchors."));
    }
    if (issues.length > 0) return invalid(issues);
    coordinates = routeCoordinates(input.shot);
  } else {
    if (input.shot.radiusM > MAX_ORBIT_RADIUS_M) {
      return invalid([issue(["shot", "radiusM"], "unsupported", "Orbit radius exceeds the 10000 metre local calculation limit.")]);
    }
    const count = orbitSampleCount(input.shot);
    if (count === undefined) {
      return invalid([issue(["shot", "radiusM"], "unsupported", "Orbit requires more than 200 waypoints at the one metre chord limit.")]);
    }
    coordinates = orbitCoordinates(input.shot, count);
    if (coordinates.length !== count) {
      return invalid([issue(["shot", "radiusM"], "unsupported", "Orbit coordinates could not be calculated as finite values.")]);
    }
  }

  const waypoints: Waypoint[] = [];
  for (const coordinate of coordinates) {
    const framing = framingForWaypoint(coordinate, input.heightAboveTakeoffM, input.framing);
    if ("code" in framing) {
      issues.push(framing);
      continue;
    }
    waypoints.push({
      coordinate: { latitudeDeg: coordinate.latitudeDeg, longitudeDeg: coordinate.longitudeDeg },
      heightAboveTakeoffM: input.heightAboveTakeoffM,
      headingDeg: framing.headingDeg,
      gimbalPitchDeg: framing.gimbalPitchDeg,
    });
  }

  if (issues.length > 0) return invalid(issues);
  return { kind: "calculated", waypoints };
}

/**
 * Plans a deterministic orbit or ordered route without mutating the input.
 * Coordinates are WGS84 latitude and longitude in degrees. Waypoint and target
 * heights are metres relative to the same caller-planned takeoff elevation.
 *
 * @param input Plain objects and arrays with stored properties, including
 * nested fields. Accessors, proxies and class instances are unsupported.
 * @returns A `calculated` result with ordered waypoints containing `coordinate`,
 * `heightAboveTakeoffM`, `headingDeg` and `gimbalPitchDeg`, or an `invalid-input`
 * result with structured issues.
 * @throws Property-access errors from unsupported objects.
 */
export function planMission(input: unknown): PlanResult {
  const parsed = missionInputSchema.safeParse(input, { reportInput: true });
  if (!parsed.success) return invalid(parseIssues(parsed.error));
  return calculate(parsed.data);
}
