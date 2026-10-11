export type Coordinate = Readonly<{
  latitudeDeg: number;
  longitudeDeg: number;
}>;

export type Target = Readonly<{
  coordinate: Coordinate;
  heightAboveTakeoffM: number;
}>;

export type Framing =
  | Readonly<{
      kind: "fixed";
      headingDeg: number;
      gimbalPitchDeg: number;
    }>
  | Readonly<{
      kind: "face-target";
      target: Target;
    }>;

export type Shot =
  | Readonly<{
      kind: "orbit";
      centre: Coordinate;
      radiusM: number;
      startBearingDeg: number;
      direction: "clockwise" | "counterclockwise";
      arc:
        | Readonly<{ kind: "closed" }>
        | Readonly<{ kind: "partial"; sweepDeg: number }>;
    }>
  | Readonly<{
      kind: "route";
      anchors: readonly Coordinate[];
    }>;

export type MissionInput = Readonly<{
  shot: Shot;
  heightAboveTakeoffM: number;
  framing: Framing;
}>;

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
  | Readonly<{
      kind: "calculated";
      waypoints: readonly Waypoint[];
    }>
  | Readonly<{
      kind: "invalid-input";
      issues: readonly InputIssue[];
    }>;

export function planMission(_input: unknown): PlanResult {
  throw new Error("Not implemented");
}
