import { describe, expect, it } from 'vitest';
import { analyseDraft, editorReducer } from '../../web/editor.js';
import { firstId, makeState } from './fixtures.js';

describe('Completed map moves', () => {
  it('changes both coordinates atomically, retaining identity, order and other source', () => {
    const before = makeState();
    const snapshot = structuredClone(before);
    const coordinate = { latitude: '37.7779', longitude: '-122.42' };
    const next = editorReducer(before, { type: 'move-point', id: firstId, coordinate });

    expect(before).toEqual(snapshot);
    expect(next.draft).toEqual({
      ...snapshot.draft,
      points: snapshot.draft.points.map((point) => point.id === firstId ? { ...point, coordinate } : point),
    });
    expect(next.selectedPointId).toBe(firstId);
    expect(next.revision).toBe(snapshot.revision + 1);
    expect(next.review).toEqual({ kind: 'unreviewed' });
    const analysis = analyseDraft(next.draft);
    expect(analysis.route.kind).toBe('calculated');
    if (analysis.route.kind === 'calculated') {
      expect(analysis.route.waypoints[0]?.coordinate).toEqual({ latitudeDeg: 37.7779, longitudeDeg: -122.42 });
    }
  });

  it.each(['same position', 'missing point'])('preserves source and review for %s', (scenario) => {
    const before = makeState();
    const snapshot = structuredClone(before);
    const next = editorReducer(before, {
      type: 'move-point',
      id: scenario === 'same position' ? firstId : '99999999-9999-4999-8999-999999999999',
      coordinate: { latitude: '37.7749', longitude: '-122.4194' },
    });
    expect(next).toEqual(snapshot);
    expect(before).toEqual(snapshot);
  });
});
