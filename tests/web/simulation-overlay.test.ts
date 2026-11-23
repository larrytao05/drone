import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIXTURE_COORDS,
  getBlockedSegmentIndices,
  getBlockedSegmentLabel,
  getRouteCoordinates,
  interpolateRouteCoordinate,
} from '../../web/map-simulation.js';
import { analyseDraft } from '../../web/editor.js';
import { buildMapGeometry } from '../../web/map-geometry.js';
import { blockedLineData } from '../../web/map-simulation.js';
import { makeDraft } from './fixtures.js';

describe('simulation overlay projection and geometry', () => {
  const coords = [
    { latitudeDeg: 37.7749, longitudeDeg: -122.4194 },
    { latitudeDeg: 37.7759, longitudeDeg: -122.4184 },
    { latitudeDeg: 37.7769, longitudeDeg: -122.4174 },
  ];

  it('interpolates along multiple route legs according to progress', () => {
    // Segment 0: start progress = 0.24
    const start = interpolateRouteCoordinate(coords, 0.24);
    expect(start.latitudeDeg).toBeCloseTo(37.7749 + 0.001 * 0.24, 6);
    expect(start.longitudeDeg).toBeCloseTo(-122.4194 + 0.001 * 0.24, 6);

    // Segment 0: hold progress = 0.80
    const hold = interpolateRouteCoordinate(coords, 0.80);
    expect(hold.latitudeDeg).toBeCloseTo(37.7749 + 0.001 * 0.80, 6);
    expect(hold.longitudeDeg).toBeCloseTo(-122.4194 + 0.001 * 0.80, 6);

    // Segment 1: resume progress = 1.20 (20% into WP 2 -> WP 3)
    const resume = interpolateRouteCoordinate(coords, 1.20);
    expect(resume.latitudeDeg).toBeCloseTo(37.7759 + 0.001 * 0.20, 6);
    expect(resume.longitudeDeg).toBeCloseTo(-122.4184 + 0.001 * 0.20, 6);

    // Progress at end
    const end = interpolateRouteCoordinate(coords, 2.0);
    expect(end.latitudeDeg).toBeCloseTo(37.7769, 6);
    expect(end.longitudeDeg).toBeCloseTo(-122.4174, 6);
  });

  it('interpolates across the antimeridian along the shortest path without wrapping around the globe', () => {
    const crossingRoute = [
      { latitudeDeg: 10, longitudeDeg: 179 },
      { latitudeDeg: 10, longitudeDeg: -179 },
    ];

    // Midpoint should be at the antimeridian (180 or -180), not near prime meridian (0)
    const mid = interpolateRouteCoordinate(crossingRoute, 0.5);
    expect(mid.latitudeDeg).toBeCloseTo(10, 6);
    expect(Math.abs(mid.longitudeDeg)).toBe(180);

    // 25% progress: 179.5
    const q1 = interpolateRouteCoordinate(crossingRoute, 0.25);
    expect(q1.longitudeDeg).toBeCloseTo(179.5, 6);

    // 75% progress: -179.5
    const q3 = interpolateRouteCoordinate(crossingRoute, 0.75);
    expect(q3.longitudeDeg).toBeCloseTo(-179.5, 6);
  });

  it('interpolates across the antimeridian in the reverse direction (west to east)', () => {
    const reverseCrossing = [
      { latitudeDeg: -5, longitudeDeg: -179 },
      { latitudeDeg: -5, longitudeDeg: 179 },
    ];

    const mid = interpolateRouteCoordinate(reverseCrossing, 0.5);
    expect(mid.latitudeDeg).toBeCloseTo(-5, 6);
    expect(Math.abs(mid.longitudeDeg)).toBe(180);

    const q1 = interpolateRouteCoordinate(reverseCrossing, 0.25);
    expect(q1.longitudeDeg).toBeCloseTo(-179.5, 6);

    const q3 = interpolateRouteCoordinate(reverseCrossing, 0.75);
    expect(q3.longitudeDeg).toBeCloseTo(179.5, 6);
  });

  it('handles boundary conditions: empty, single point, and overshoot', () => {
    const empty = interpolateRouteCoordinate([], 0.5);
    expect(empty).toEqual({ latitudeDeg: 37.7749, longitudeDeg: -122.4194 });

    const single = [{ latitudeDeg: 38.0, longitudeDeg: -122.0 }];
    const fromSingle = interpolateRouteCoordinate(single, 0.5);
    expect(fromSingle).toEqual({ latitudeDeg: 38.0, longitudeDeg: -122.0 });

    const overshoot = interpolateRouteCoordinate(coords, 5.0);
    expect(overshoot.latitudeDeg).toBeCloseTo(37.7769, 6);
    expect(overshoot.longitudeDeg).toBeCloseTo(-122.4174, 6);
  });

  it('derives blocked segment indices and label from waypoint count', () => {
    // 2 points: segment 0 (WP 1 to WP 2)
    expect(getBlockedSegmentIndices(2)).toEqual({ startIndex: 0, endIndex: 1 });
    expect(getBlockedSegmentLabel(2)).toBe('WP 1 to WP 2');

    // 3 points: segment 1 (WP 2 to WP 3)
    expect(getBlockedSegmentIndices(3)).toEqual({ startIndex: 1, endIndex: 2 });
    expect(getBlockedSegmentLabel(3)).toBe('WP 2 to WP 3');

    // 4+ points: segment 1 (WP 2 to WP 3)
    expect(getBlockedSegmentIndices(4)).toEqual({ startIndex: 1, endIndex: 2 });
    expect(getBlockedSegmentLabel(4)).toBe('WP 2 to WP 3');
  });

  it('splits blocked segment across antimeridian into multiple GeoJSON LineStrings', () => {
    const normal = blockedLineData(
      { latitudeDeg: 37.7, longitudeDeg: -122.4 },
      { latitudeDeg: 37.8, longitudeDeg: -122.3 },
    );
    expect(normal.features).toHaveLength(1);
    expect(normal.features[0]!.geometry.coordinates).toEqual([[-122.4, 37.7], [-122.3, 37.8]]);

    const crossing = blockedLineData(
      { latitudeDeg: 15, longitudeDeg: 179 },
      { latitudeDeg: 15, longitudeDeg: -179 },
    );
    expect(crossing.features).toHaveLength(2);
    expect(crossing.features[0]!.geometry.coordinates).toEqual([[179, 15], [180, 15]]);
    expect(crossing.features[1]!.geometry.coordinates).toEqual([[-180, 15], [-179, 15]]);
  });

  it('extracts route coordinates from calculated geometry or points without dropping antimeridian splits', () => {
    const analysis = analyseDraft(makeDraft());
    const geometry = buildMapGeometry({
      sourcePoints: analysis.sourcePoints,
      route: analysis.route,
      takeoff: analysis.takeoff,
      target: analysis.target,
    });

    const routeCoords = getRouteCoordinates(geometry);
    expect(routeCoords.length).toBeGreaterThanOrEqual(2);
    expect(routeCoords[0]!.latitudeDeg).toBeCloseTo(37.7749, 4);

    // Antimeridian split geometry retains all planned waypoints
    const splitDraft = makeDraft({
      points: [
        { id: '00000000-0000-4000-8000-000000000001', coordinate: { latitude: '0', longitude: '179' } },
        { id: '00000000-0000-4000-8000-000000000002', coordinate: { latitude: '0', longitude: '-179' } },
      ],
    });
    const splitAnalysis = analyseDraft(splitDraft);
    const splitGeom = buildMapGeometry({
      sourcePoints: splitAnalysis.sourcePoints,
      route: splitAnalysis.route,
      takeoff: splitAnalysis.takeoff,
      target: splitAnalysis.target,
    });
    // geometry.lines has 2 lines because of antimeridian split
    expect(splitGeom.lines.length).toBe(2);
    // getRouteCoordinates extracts both points from planned geometry, not just geometry.lines[0]
    const splitCoords = getRouteCoordinates(splitGeom);
    expect(splitCoords).toHaveLength(2);
    expect(splitCoords[0]!.longitudeDeg).toBe(179);
    expect(splitCoords[1]!.longitudeDeg).toBe(-179);

    // Fallback on empty geometry
    const emptyGeom = {
      points: [], lines: [], headings: [], omittedPointIds: [], takeoff: null, target: null,
    };
    expect(getRouteCoordinates(emptyGeom)).toBe(DEFAULT_FIXTURE_COORDS);
  });
});
