import { describe, expect, it } from 'vitest';
import { analyseDraft, editorReducer } from '../../web/editor.js';
import { firstId, secondId, thirdId, makeDraft, makePoints, makeState } from './fixtures.js';

function threePointState() {
  const draft = makeDraft();
  return makeState({ draft: { ...draft, points: [...draft.points, { id: thirdId, coordinate: { latitude: '37.777', longitude: '-122.42' } }] } });
}

describe('Route ordering', () => {
  it.each([
    { beforeId: thirdId, order: [secondId, firstId, thirdId] },
    { beforeId: null, order: [secondId, thirdId, firstId] },
  ])('moves before $beforeId while preserving selected identity and source values', ({ beforeId, order }) => {
    const before = threePointState();
    const snapshot = structuredClone(before);
    const next = editorReducer(before, { type: 'reorder-point', id: firstId, beforeId });
    expect(next.draft.points.map((point) => point.id)).toEqual(order);
    for (const point of snapshot.draft.points) expect(next.draft.points.find((item) => item.id === point.id)).toEqual(point);
    expect({ ...next.draft, points: snapshot.draft.points }).toEqual(snapshot.draft);
    expect(next.selectedPointId).toBe(firstId);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(before).toEqual(snapshot);
    const result = analyseDraft(next.draft);
    expect(result.route.kind).toBe('calculated');
    if (result.route.kind === 'calculated') {
      expect(result.route.waypoints.map((point) => point.coordinate.latitudeDeg))
        .toEqual(next.draft.points.map((point) => Number(point.coordinate.latitude)));
    }
  });

  it.each([
    { id: firstId, beforeId: firstId },
    { id: firstId, beforeId: secondId },
    { id: thirdId, beforeId: null },
    { id: 'missing', beforeId: firstId },
    { id: firstId, beforeId: 'missing' },
  ])('ignores a self, same-position or stale reorder $id -> $beforeId', (action) => {
    const before = threePointState();
    const snapshot = structuredClone(before);
    expect(editorReducer(before, { type: 'reorder-point', ...action })).toEqual(snapshot);
  });

  it('reorders 100 points without dropping or copying a point', () => {
    const points = makePoints(100);
    const first = points[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('Fixture must contain a first point');
    const before = makeState({ draft: makeDraft({ points }), selectedPointId: first.id });
    const next = editorReducer(before, { type: 'reorder-point', id: first.id, beforeId: null });
    expect(next.draft.points).toEqual([...points.slice(1), first]);
    expect(next.selectedPointId).toBe(first.id);
  });
});
