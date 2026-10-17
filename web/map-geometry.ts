import type { Coordinate } from '@drone/mission-planner';
import type { DraftAnalysis } from './mission-input';

const MAX_MERCATOR_LATITUDE = 85.0511287798066;

export type MapGeometry = Readonly<{
  points: readonly Readonly<{ id: string; coordinate: Coordinate }>[];
  lines: readonly (readonly Coordinate[])[];
  headings: readonly Readonly<{ coordinate: Coordinate; headingDeg: number; waypointOrdinal: number }>[];
  omittedPointIds: readonly string[];
  takeoff: Coordinate | null;
  target: Coordinate | null;
}>;

type BuildMapGeometryInput = Readonly<{
  sourcePoints: DraftAnalysis['sourcePoints'];
  route: DraftAnalysis['route'];
  takeoff: Coordinate | null;
  target: Coordinate | null;
}>;

function isProjectable(coordinate: Coordinate): boolean {
  return Math.abs(coordinate.latitudeDeg) <= MAX_MERCATOR_LATITUDE;
}

export function normaliseMapCoordinate(coordinate: Coordinate): Coordinate {
  if (coordinate.longitudeDeg >= -180 && coordinate.longitudeDeg <= 180) return coordinate;
  const longitudeDeg = ((coordinate.longitudeDeg + 180) % 360 + 360) % 360 - 180;
  return { ...coordinate, longitudeDeg };
}

function sameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.latitudeDeg === right.latitudeDeg && left.longitudeDeg === right.longitudeDeg;
}

function mapCoordinate(coordinate: Coordinate): Coordinate | null {
  if (!isProjectable(coordinate)) return null;
  return normaliseMapCoordinate(coordinate);
}

function crossingBoundary(start: Coordinate, end: Coordinate): Readonly<{
  start: Coordinate;
  end: Coordinate;
}> | null {
  const longitudeDifference = end.longitudeDeg - start.longitudeDeg;
  if (Math.abs(start.longitudeDeg) === 180 && Math.abs(end.longitudeDeg) === 180
    && start.longitudeDeg !== end.longitudeDeg) {
    return {
      start: { latitudeDeg: end.latitudeDeg, longitudeDeg: start.longitudeDeg },
      end: { latitudeDeg: end.latitudeDeg, longitudeDeg: end.longitudeDeg },
    };
  }
  if (longitudeDifference > 180) {
    const adjustedEnd = end.longitudeDeg - 360;
    const fraction = (-180 - start.longitudeDeg) / (adjustedEnd - start.longitudeDeg);
    const latitudeDeg = start.latitudeDeg + (end.latitudeDeg - start.latitudeDeg) * fraction;
    return {
      start: { latitudeDeg, longitudeDeg: -180 },
      end: { latitudeDeg, longitudeDeg: 180 },
    };
  }
  if (longitudeDifference < -180) {
    const adjustedEnd = end.longitudeDeg + 360;
    const fraction = (180 - start.longitudeDeg) / (adjustedEnd - start.longitudeDeg);
    const latitudeDeg = start.latitudeDeg + (end.latitudeDeg - start.latitudeDeg) * fraction;
    return {
      start: { latitudeDeg, longitudeDeg: 180 },
      end: { latitudeDeg, longitudeDeg: -180 },
    };
  }
  return null;
}

function routeLines(waypoints: readonly Readonly<{ coordinate: Coordinate }>[]): readonly (readonly Coordinate[])[] {
  const lines: Coordinate[][] = [];
  let current: Coordinate[] = [];

  function finishLine() {
    if (current.length > 1) lines.push(current);
    current = [];
  }

  for (const waypoint of waypoints) {
    const coordinate = mapCoordinate(waypoint.coordinate);
    if (coordinate === null) {
      finishLine();
      continue;
    }
    const previous = current.at(-1);
    if (previous === undefined) {
      current.push(coordinate);
      continue;
    }

    const boundary = crossingBoundary(previous, coordinate);
    if (boundary === null) {
      current.push(coordinate);
      continue;
    }

    if (!sameCoordinate(previous, boundary.start)) current.push(boundary.start);
    finishLine();
    current.push(boundary.end);
    if (!sameCoordinate(boundary.end, coordinate)) current.push(coordinate);
  }

  finishLine();
  return lines;
}

export function buildMapGeometry({ sourcePoints, route, takeoff, target }: BuildMapGeometryInput): MapGeometry {
  const points = sourcePoints.flatMap(({ id, coordinate }) => {
    const mapPoint = mapCoordinate(coordinate);
    return mapPoint === null ? [] : [{ id, coordinate: mapPoint }];
  });
  const omittedPointIds = sourcePoints
    .filter(({ coordinate }) => !isProjectable(coordinate))
    .map(({ id }) => id);
  const planned = route.kind === 'calculated' ? route.waypoints : [];
  const headings = planned.flatMap(({ coordinate, headingDeg }, index) => {
    const mapPoint = mapCoordinate(coordinate);
    return mapPoint === null ? [] : [{ coordinate: mapPoint, headingDeg, waypointOrdinal: index + 1 }];
  });

  return {
    points,
    lines: route.kind === 'calculated' ? routeLines(planned) : [],
    headings,
    omittedPointIds,
    takeoff: takeoff === null ? null : mapCoordinate(takeoff),
    target: target === null ? null : mapCoordinate(target),
  };
}
