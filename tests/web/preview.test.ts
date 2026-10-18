import { describe, expect, it } from 'vitest';
import { analyseDraft, editorReducer } from '../../web/editor.js';
import { planMission } from '../../src/index.js';
import { firstId, secondId, makeDraft, makePoints, makeState } from './fixtures.js';

describe('Current calculated preview', () => {
  it.each([0, 1, 2, 100, 101])('delegates route cardinality %s to the planner while retaining editable source', (count) => {
    const points = makePoints(count);
    const analysis = analyseDraft(makeDraft({ points }));
    expect(analysis.sourcePoints).toHaveLength(count);
    expect(analysis.route.kind).toBe(count >= 2 && count <= 100 ? 'calculated' : 'not-calculated');
    if (analysis.route.kind === 'calculated') expect(analysis.route.waypoints).toHaveLength(count);
  });
  it('matches the public planner output without inventing intermediate anchors', () => {
    const draft = makeDraft();
    const expected = planMission({ shot: { kind: 'route', anchors: draft.points.map((point) => ({ latitudeDeg: Number(point.coordinate.latitude), longitudeDeg: Number(point.coordinate.longitude) })) }, heightAboveTakeoffM: 30, framing: { kind: 'fixed', headingDeg: 90, gimbalPitchDeg: -45 } });
    const route = analyseDraft(draft).route;
    expect(route.kind).toBe('calculated');
    if (route.kind !== 'calculated') throw new Error('Expected a calculated route');
    const { input, ...calculation } = route;
    expect(planMission(input)).toEqual(calculation);
    expect(calculation).toEqual(expected);
  });
  it.each(['height', 'coordinates', 'framing'])('clears a previously calculated plan after invalid %s', (field) => {
    const before = makeDraft();
    expect(analyseDraft(before).route.kind).toBe('calculated');
    const invalid = field === 'height' ? makeDraft({ height: '' }) : field === 'framing'
      ? makeDraft({ framing: { kind: 'unselected' } })
      : makeDraft({ points: before.points.map((point) => point.id === firstId ? { ...point, coordinate: { ...point.coordinate, latitude: '-' } } : point) });
    const analysis = analyseDraft(invalid);
    expect(analysis.route.kind).toBe('not-calculated');
    expect(analysis.route).not.toHaveProperty('waypoints');
    expect(analysis.reviewEligible).toBe(false);
    expect(analysis.sourcePoints).toHaveLength(field === 'coordinates' ? 1 : 2);
  });
  it('assigns coordinate issues to stable IDs after reorder', () => {
    const draft = makeDraft();
    const invalid = { ...draft, points: draft.points.map((point) => point.id === firstId ? { ...point, coordinate: { latitude: '91', longitude: '0' } } : point) };
    const next = editorReducer(makeState({ draft: invalid, review: { kind: 'unreviewed' } }), { type: 'reorder-point', id: firstId, beforeId: null });
    expect(next.draft.points.map((point) => point.id)).toEqual([secondId, firstId]);
    const result = analyseDraft(next.draft);
    expect(result.route.kind).toBe('not-calculated');
    if (result.route.kind === 'not-calculated') {
      expect(result.route.issues.some((issue) => issue.pointId === firstId)).toBe(true);
      expect(result.route.issues.some((issue) => issue.pointId === secondId)).toBe(false);
    }
  });
  it.each(['coincident', 'distant'])('retains planner target-geometry errors for %s target as route errors', (scenario) => {
    const draft = makeDraft({ framing: { kind: 'face-target', coordinate: scenario === 'coincident' ? { latitude: '37.7749', longitude: '-122.4194' } : { latitude: '0', longitude: '0' }, height: '0' } });
    const result = analyseDraft(draft);
    expect(result.route.kind).toBe('not-calculated');
    if (result.route.kind === 'not-calculated') {
      expect(result.route.issues.length).toBeGreaterThan(0);
      expect(result.route.issues.every((issue) => issue.pointId === undefined)).toBe(true);
    }
  });
});
