import { describe, expect, it } from 'vitest';
import { analyseDraft } from '../../web/editor.js';
import { buildMapGeometry, normaliseMapCoordinate } from '../../web/map-geometry.js';
import { firstId, secondId, makeDraft } from './fixtures.js';

function geometry(draft = makeDraft()) {
  const analysis = analyseDraft(draft);
  return buildMapGeometry({ sourcePoints: analysis.sourcePoints, route: analysis.route, takeoff: analysis.takeoff, target: null });
}

describe('Source-to-map geometry', () => {
  it.each([{ input: 181, output: -179 }, { input: -181, output: 179 }, { input: 541, output: -179 }, { input: -541, output: 179 }])('normalises world longitude $input without changing latitude', ({ input, output }) => {
    expect(normaliseMapCoordinate({ latitudeDeg: 37, longitudeDeg: input })).toEqual({ latitudeDeg: 37, longitudeDeg: output });
  });
  it.each([180, -180, 540, -540])('retains a valid dateline boundary for %s', (longitudeDeg) => {
    const result = normaliseMapCoordinate({ latitudeDeg: 0, longitudeDeg });
    expect(Math.abs(result.longitudeDeg)).toBe(180);
  });
  it('draws only the route, with headings from the calculated plan and no takeoff connector', () => {
    const draft = makeDraft();
    const snapshot = structuredClone(draft);
    const result = geometry(draft);
    expect(result.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(result.lines).toEqual([[{ latitudeDeg: 37.7749, longitudeDeg: -122.4194 }, { latitudeDeg: 37.7759, longitudeDeg: -122.4184 }]]);
    expect(result.headings).toEqual([{ coordinate: { latitudeDeg: 37.7749, longitudeDeg: -122.4194 }, headingDeg: 90 }, { coordinate: { latitudeDeg: 37.7759, longitudeDeg: -122.4184 }, headingDeg: 90 }]);
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
