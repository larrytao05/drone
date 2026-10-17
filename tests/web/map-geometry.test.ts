import { describe, expect, it } from 'vitest';
import { analyseDraft } from '../../web/editor.js';
import { buildMapGeometry, normaliseMapCoordinate } from '../../web/map-geometry.js';
import { firstId, secondId, makeDraft } from './fixtures.js';

function geometry(draft = makeDraft()) {
  const analysis = analyseDraft(draft);
  return buildMapGeometry({ sourcePoints: analysis.sourcePoints, route: analysis.route, takeoff: analysis.takeoff, target: analysis.target });
}

describe('Source-to-map geometry', () => {
  it.each([{ input: 181, output: -179 }, { input: -181, output: 179 }, { input: 541, output: -179 }, { input: -541, output: 179 }])('normalises world longitude $input without changing latitude', ({ input, output }) => {
    expect(normaliseMapCoordinate({ latitudeDeg: 37, longitudeDeg: input })).toEqual({ latitudeDeg: 37, longitudeDeg: output });
  });
  it.each([180, -180, 540, -540])('retains a valid dateline boundary for %s', (longitudeDeg) => {
    const result = normaliseMapCoordinate({ latitudeDeg: 0, longitudeDeg });
    if (Math.abs(longitudeDeg) === 180) expect(result.longitudeDeg).toBe(longitudeDeg);
    else expect(Math.abs(result.longitudeDeg)).toBe(180);
  });
  it('preserves in-range longitude precision exactly', () => {
    const coordinate = { latitudeDeg: 0, longitudeDeg: 179.99999999999997 };
    expect(normaliseMapCoordinate(coordinate)).toBe(coordinate);
    expect(normaliseMapCoordinate(coordinate).longitudeDeg).toBe(179.99999999999997);
  });
  it('draws only the route, with headings from the calculated plan and no takeoff connector', () => {
    const draft = makeDraft();
    const snapshot = structuredClone(draft);
    const result = geometry(draft);
    expect(result.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(result.lines).toEqual([[{ latitudeDeg: 37.7749, longitudeDeg: -122.4194 }, { latitudeDeg: 37.7759, longitudeDeg: -122.4184 }]]);
    expect(result.headings).toEqual([{ coordinate: { latitudeDeg: 37.7749, longitudeDeg: -122.4194 }, headingDeg: 90 }, { coordinate: { latitudeDeg: 37.7759, longitudeDeg: -122.4184 }, headingDeg: 90 }]);
    expect(result.takeoff).toEqual({ latitudeDeg: 37.774, longitudeDeg: -122.42 });
    expect(result.target).toBeNull();
    expect(draft).toEqual(snapshot);
  });
  it('removes derived lines and headings while retaining valid source points', () => {
    expect(geometry().lines.length).toBeGreaterThan(0);
    const result = geometry(makeDraft({ height: '' }));
    expect(result.lines).toEqual([]);
    expect(result.headings).toEqual([]);
    expect(result.points.map((point) => point.id)).toEqual([firstId, secondId]);
  });
  it('splits the dateline for display without adding source anchors or changing coordinates', () => {
    const draft = makeDraft({ points: [{ id: firstId, coordinate: { latitude: '0', longitude: '179' } }, { id: secondId, coordinate: { latitude: '0', longitude: '-179' } }] });
    const snapshot = structuredClone(draft);
    const result = geometry(draft);
    expect(result.lines).toEqual([[{ latitudeDeg: 0, longitudeDeg: 179 }, { latitudeDeg: 0, longitudeDeg: 180 }], [{ latitudeDeg: 0, longitudeDeg: -180 }, { latitudeDeg: 0, longitudeDeg: -179 }]]);
    expect(result.points.map((point) => point.coordinate.longitudeDeg)).toEqual([179, -179]);
    expect(draft).toEqual(snapshot);
    const plan = analyseDraft(draft);
    if (plan.route.kind === 'calculated') expect(plan.route.waypoints).toHaveLength(2);
    else throw new Error('Fixed-framing dateline fixture must calculate');
  });
  it('splits a reverse dateline crossing in the opposite direction', () => {
    const draft = makeDraft({ points: [{ id: firstId, coordinate: { latitude: '0', longitude: '-179' } }, { id: secondId, coordinate: { latitude: '0', longitude: '179' } }] });
    expect(geometry(draft).lines).toEqual([
      [{ latitudeDeg: 0, longitudeDeg: -179 }, { latitudeDeg: 0, longitudeDeg: -180 }],
      [{ latitudeDeg: 0, longitudeDeg: 180 }, { latitudeDeg: 0, longitudeDeg: 179 }],
    ]);
  });
  it.each([
    { longitudes: ['179', '-180'], expected: [[179, 180]] },
    { longitudes: ['180', '-179'], expected: [[-180, -179]] },
    { longitudes: ['180', '-180'], expected: [[180, 180]] },
    { longitudes: ['-180', '180'], expected: [[-180, -180]] },
  ])('handles boundary endpoints $longitudes without non-finite coordinates', ({ longitudes, expected }) => {
    const draft = makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '0', longitude: longitudes[0] ?? '' } },
      { id: secondId, coordinate: { latitude: '1', longitude: longitudes[1] ?? '' } },
    ] });
    const result = geometry(draft);
    expect(result.lines.map((line) => line.map((coordinate) => coordinate.longitudeDeg))).toEqual(expected);
    expect(result.lines.flat().every(({ latitudeDeg, longitudeDeg }) => Number.isFinite(latitudeDeg) && Number.isFinite(longitudeDeg))).toBe(true);
  });
  it('retains duplicate source marks without inventing a route segment', () => {
    const draft = makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '1', longitude: '2' } },
      { id: secondId, coordinate: { latitude: '1', longitude: '2' } },
    ] });
    const result = geometry(draft);
    expect(result.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(result.lines).toEqual([[{ latitudeDeg: 1, longitudeDeg: 2 }, { latitudeDeg: 1, longitudeDeg: 2 }]]);
    expect(result.headings).toHaveLength(2);
  });
  it('ends segments at polar interruptions and resumes at the next projectable route point', () => {
    const draft = makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '0', longitude: '0' } },
      { id: secondId, coordinate: { latitude: '0', longitude: '1' } },
      { id: '33333333-3333-4333-8333-333333333333', coordinate: { latitude: '90', longitude: '1' } },
      { id: '44444444-4444-4444-8444-444444444444', coordinate: { latitude: '1', longitude: '1' } },
      { id: '55555555-5555-4555-8555-555555555555', coordinate: { latitude: '2', longitude: '2' } },
    ] });
    const result = geometry(draft);
    expect(result.omittedPointIds).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(result.lines).toEqual([
      [{ latitudeDeg: 0, longitudeDeg: 0 }, { latitudeDeg: 0, longitudeDeg: 1 }],
      [{ latitudeDeg: 1, longitudeDeg: 1 }, { latitudeDeg: 2, longitudeDeg: 2 }],
    ]);
  });
  it('keeps a valid target marker available when route settings are incomplete', () => {
    const draft = makeDraft({
      height: '',
      framing: { kind: 'face-target', coordinate: { latitude: '38', longitude: '-122' }, height: '' },
    });
    const result = geometry(draft);
    expect(result.target).toEqual({ latitudeDeg: 38, longitudeDeg: -122 });
    expect(result.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(result.lines).toEqual([]);
    expect(result.headings).toEqual([]);
  });
  it('omits unprojectable polar marks and incident segments, preserving exact source and table data', () => {
    const draft = makeDraft({ points: [{ id: firstId, coordinate: { latitude: '90', longitude: '0' } }, { id: secondId, coordinate: { latitude: '80', longitude: '1' } }] });
    const result = geometry(draft);
    expect(result.omittedPointIds).toEqual([firstId]);
    expect(result.points.map((point) => point.id)).toEqual([secondId]);
    expect(result.lines).toEqual([]);
    expect(result.headings).toHaveLength(1);
    const analysis = analyseDraft(draft);
    expect(analysis.route.kind).toBe('calculated');
    if (analysis.route.kind === 'calculated') expect(analysis.route.waypoints[0]?.coordinate.latitudeDeg).toBe(90);
    expect(draft.points[0]?.coordinate.latitude).toBe('90');
  });
});
