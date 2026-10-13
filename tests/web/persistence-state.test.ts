import { describe, expect, it } from 'vitest';
import { editorReducer, isSaved } from '../../web/editor.js';
import { firstId, makeDraft, makeState } from './fixtures.js';

describe('saved and reviewed state', () => {
  it('starts unsaved and changes to saved only after a successful acknowledgement', () => {
    const state = makeState({ review: { kind: 'unreviewed' } });
    expect(isSaved(state)).toBe(false);

    const saved = editorReducer(state, { type: 'save-succeeded', revision: state.revision, reviewed: false });
    expect(isSaved(saved)).toBe(true);
    expect(saved.review).toEqual({ kind: 'unreviewed' });
  });

  it('does not acknowledge a stale revision or change its review state', () => {
    const state = makeState();
    const next = editorReducer(state, { type: 'save-succeeded', revision: state.revision - 1, reviewed: false });

    expect(next).toEqual(state);
    expect(isSaved(next)).toBe(false);
  });

  it('marks only the captured current revision reviewed after save success', () => {
    const state = makeState({ review: { kind: 'unreviewed' } });
    const next = editorReducer(state, { type: 'save-succeeded', revision: state.revision, reviewed: true });

    expect(next.review).toEqual({ kind: 'reviewed', revision: state.revision });
    expect(isSaved(next)).toBe(true);
  });

  it('does not mark an ineligible draft reviewed even if asked by an acknowledgement', () => {
    const state = makeState({ draft: makeDraft({ takeoff: null }), review: { kind: 'unreviewed' } });
    const next = editorReducer(state, { type: 'save-succeeded', revision: state.revision, reviewed: true });

    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(next).toEqual(state);
    expect(isSaved(next)).toBe(false);
  });

  it('tracks source and review while selection and tool remain outside saved equality', () => {
    const state = editorReducer(makeState({ savedSnapshotKey: null }), {
      type: 'save-succeeded', revision: 8, reviewed: true,
    });
    expect(isSaved(state)).toBe(true);
    expect(isSaved(editorReducer(state, { type: 'select-point', id: firstId }))).toBe(true);
    expect(isSaved(editorReducer(state, { type: 'set-tool', tool: 'add-points' }))).toBe(true);

    const changed = editorReducer(state, { type: 'set-name', value: 'Changed route' });
    expect(changed.review).toEqual({ kind: 'unreviewed' });
    expect(isSaved(changed)).toBe(false);

    const restored = editorReducer(changed, { type: 'set-name', value: state.draft.name });
    expect(restored.review).toEqual({ kind: 'unreviewed' });
    expect(isSaved(restored)).toBe(false);
  });

  it('loads source as a saved baseline and gates restored review on eligibility', () => {
    const current = makeState();
    const loaded = editorReducer(current, { type: 'load-draft', draft: makeDraft(), reviewed: true });
    expect(isSaved(loaded)).toBe(true);
    expect(loaded.review).toEqual({ kind: 'reviewed', revision: loaded.revision });
    expect(loaded.selectedPointId).toBeNull();
    expect(loaded.tool).toBe('select');

    const incomplete = editorReducer(current, {
      type: 'load-draft', draft: makeDraft({ takeoff: null }), reviewed: true,
    });
    expect(isSaved(incomplete)).toBe(true);
    expect(incomplete.review).toEqual({ kind: 'unreviewed' });
  });
  it('returns to saved when an unreviewed source edit is restored to the saved values', () => {
    const saved = editorReducer(makeState({ review: { kind: 'unreviewed' } }), { type: 'save-succeeded', revision: 8, reviewed: false });
    const changed = editorReducer(saved, { type: 'set-name', value: 'Changed name' });
    expect(isSaved(changed)).toBe(false);
    const restored = editorReducer(changed, { type: 'set-name', value: saved.draft.name });
    expect(isSaved(restored)).toBe(true);
  });
  it('imports validated source without carrying selection, tool or reviewed state', () => {
    const before = makeState({ tool: 'add-points' });
    const snapshot = structuredClone(before);
    const draft = makeDraft({ name: 'Imported', height: '-' });
    const next = editorReducer(before, { type: 'import-draft', draft });
    expect(next.draft).toEqual(draft);
    expect(next.selectedPointId).toBeNull();
    expect(next.tool).toBe('select');
    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(next.revision).toBe(before.revision + 1);
    expect(before).toEqual(snapshot);
  });
  it('invalidates older snapshots even when imported source is identical', () => {
    const before = makeState();
    const next = editorReducer(before, { type: 'import-draft', draft: structuredClone(before.draft) });
    expect(next.revision).toBe(before.revision + 1);
    expect(next.review).toEqual({ kind: 'unreviewed' });
    const stale = editorReducer(next, { type: 'save-succeeded', revision: before.revision, reviewed: true });
    expect(stale).toEqual(next);
  });
});
