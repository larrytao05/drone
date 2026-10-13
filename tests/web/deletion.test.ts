import { describe, expect, it } from 'vitest';
import { editorReducer } from '../../web/editor.js';
import { firstId, secondId, makeDraft, makeState } from './fixtures.js';

describe('Immediate deletion', () => {
  it.each([
    { id: firstId, remaining: secondId, selected: null },
    { id: secondId, remaining: firstId, selected: firstId },
  ])('deletes $id without changing the other source fields', ({ id, remaining, selected }) => {
    const before = makeState();
    const snapshot = structuredClone(before);
    const next = editorReducer(before, { type: 'delete-point', id });
    expect(next.draft).toEqual({ ...snapshot.draft, points: snapshot.draft.points.filter((point) => point.id === remaining) });
    expect(next.selectedPointId).toBe(selected);
    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(next.revision).toBe(before.revision + 1);
    expect(before).toEqual(snapshot);
  });
  it('deletes the final point and clears selection', () => {
    const draft = makeDraft();
    const before = makeState({ draft: { ...draft, points: draft.points.slice(0, 1) }, review: { kind: 'unreviewed' } });
    const next = editorReducer(before, { type: 'delete-point', id: firstId });
    expect(next.draft.points).toEqual([]);
    expect(next.selectedPointId).toBeNull();
  });
  it.each([true, false])('ignores a missing ID, empty draft=%s', (empty) => {
    const before = makeState(empty ? { draft: makeDraft({ points: [] }), selectedPointId: null, review: { kind: 'unreviewed' } } : {});
    const snapshot = structuredClone(before);
    expect(editorReducer(before, { type: 'delete-point', id: 'missing' })).toEqual(snapshot);
  });
});
