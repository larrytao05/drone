import { describe, expect, it } from 'vitest';
import { createEditorState, editorReducer, isSaved, type EditorAction, type EditorState } from '../../web/editor.js';
import { firstId, secondId, thirdId, makeDraft, makePoints, makeState } from './fixtures.js';

const targetDraft = makeDraft({
  framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' },
});

function expectSourceChange(before: EditorState, action: EditorAction): EditorState {
  const original = structuredClone(before);
  const next = editorReducer(before, action);
  expect(before).toEqual(original);
  expect(next.revision).toBe(9);
  expect(next.review).toEqual({ kind: 'unreviewed' });
  return next;
}

describe('Source reducer boundaries', () => {
  it('returns fresh blank state without consulting clocks or randomness', () => {
    const first = createEditorState();
    const second = createEditorState();
    expect(first).toEqual({
      draft: { name: '', points: [], height: '', framing: { kind: 'unselected' }, takeoff: null },
      revision: 0, review: { kind: 'unreviewed' }, selectedPointId: null,
      tool: 'select', savedSnapshotKey: null,
    });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.draft.points).not.toBe(first.draft.points);
    expect(editorReducer(first, { type: 'new' })).toBe(first);
  });

  it('resets blank editing controls without advancing source revision', () => {
    const before = { ...createEditorState(), revision: 8, tool: 'add-points' } satisfies EditorState;
    const next = editorReducer(before, { type: 'new' });
    expect(next.tool).toBe('select');
    expect(next.revision).toBe(8);
    expect(editorReducer(next, { type: 'new' })).toBe(next);
  });

  it.each([0, 1, 2, 100, 101])('retains %i imported points without enforcing planner cardinality', (count) => {
    const points = makePoints(count);
    const before = makeState();
    const next = expectSourceChange(before, { type: 'import-draft', draft: makeDraft({ points }) });
    expect(next.draft.points).toEqual(points);
    expect(next.draft.points).toHaveLength(count);
    expect(next.selectedPointId).toBeNull();
    expect(next.tool).toBe('select');
  });

  it('retains invalid numeric text in each source field', () => {
    const named = expectSourceChange(makeState(), { type: 'set-name', value: '<script>route</script>' });
    expect(named.draft.name).toBe('<script>route</script>');
    const height = expectSourceChange(makeState(), { type: 'set-height', value: '1e' });
    expect(height.draft.height).toBe('1e');
    const point = expectSourceChange(makeState(), { type: 'set-point-coordinate', id: firstId, field: 'latitude', value: '-' });
    expect(point.draft.points[0]).toEqual({ id: firstId, coordinate: { latitude: '-', longitude: '-122.4194' } });
    const fixed = expectSourceChange(makeState(), { type: 'set-fixed-framing', field: 'pitch', value: '.' });
    expect(fixed.draft.framing).toEqual({ kind: 'fixed', heading: '90', pitch: '.' });
    const target = expectSourceChange(makeState({ draft: targetDraft }), { type: 'set-target-coordinate', field: 'latitude', value: '91' });
    expect(target.draft.framing).toEqual({ kind: 'face-target', coordinate: { latitude: '91', longitude: '-122.419' }, height: '10' });
    const targetHeight = expectSourceChange(makeState({ draft: targetDraft }), { type: 'set-target-height', value: '' });
    expect(targetHeight.draft.framing).toEqual({ kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '' });
    const takeoff = expectSourceChange(makeState(), { type: 'set-takeoff', coordinate: { latitude: 'NaN', longitude: '' } });
    expect(takeoff.draft.takeoff).toEqual({ latitude: 'NaN', longitude: '' });
  });

  it('moves both coordinates in one deterministic transition', () => {
    const before = makeState();
    const action = { type: 'move-point', id: firstId, coordinate: { latitude: '.', longitude: 'Infinity' } } satisfies EditorAction;
    const next = expectSourceChange(before, action);
    expect(next.draft).toEqual({ ...makeDraft(), points: [
      { id: firstId, coordinate: { latitude: '.', longitude: 'Infinity' } },
      { id: secondId, coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
    ] });
    expect(editorReducer(before, action)).toEqual(next);
  });

  it('appends duplicate locations under distinct supplied IDs and selects the new ID', () => {
    const before = makeState();
    const point = { id: thirdId, coordinate: { latitude: '37.7749', longitude: '-122.4194' } };
    const next = expectSourceChange(before, { type: 'append-point', point });
    expect(next.draft.points.map((item) => item.id)).toEqual([firstId, secondId, thirdId]);
    expect(next.selectedPointId).toBe(thirdId);
    expect(editorReducer(next, { type: 'append-point', point })).toBe(next);
  });

  it.each([
    { type: 'set-name', value: 'Survey route' },
    { type: 'set-height', value: '30' },
    { type: 'select-point', id: firstId },
    { type: 'select-point', id: 'missing' },
    { type: 'set-tool', tool: 'select' },
    { type: 'set-tool', tool: 'set-target' },
    { type: 'move-point', id: firstId, coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
    { type: 'set-point-coordinate', id: firstId, field: 'latitude', value: '37.7749' },
    { type: 'set-point-coordinate', id: 'missing', field: 'latitude', value: '0' },
    { type: 'delete-point', id: 'missing' },
    { type: 'reorder-point', id: firstId, beforeId: secondId },
    { type: 'reorder-point', id: firstId, beforeId: firstId },
    { type: 'reorder-point', id: firstId, beforeId: 'missing' },
    { type: 'set-framing', kind: 'fixed' },
    { type: 'set-fixed-framing', field: 'heading', value: '90' },
    { type: 'set-target-coordinate', field: 'longitude', value: '0' },
    { type: 'set-target-height', value: '0' },
    { type: 'set-target', coordinate: { latitude: '0', longitude: '0' } },
    { type: 'set-takeoff', coordinate: { latitude: '37.7740', longitude: '-122.4200' } },
    { type: 'save-succeeded', revision: 7, reviewed: false },
  ] satisfies readonly EditorAction[])('returns the same state for no-op $type', (action) => {
    const before = makeState();
    expect(editorReducer(before, action)).toBe(before);
  });

  it('returns the same state for inactive fixed and identical target source edits', () => {
    const before = makeState({ draft: targetDraft });
    const actions: readonly EditorAction[] = [
      { type: 'set-fixed-framing', field: 'heading', value: '180' },
      { type: 'set-target-coordinate', field: 'latitude', value: '37.776' },
      { type: 'set-target-height', value: '10' },
      { type: 'set-target', coordinate: { latitude: '37.776', longitude: '-122.419' } },
    ];
    for (const action of actions) expect(editorReducer(before, action)).toBe(before);
  });

  it('keeps the saved baseline through New and import and compares only source and review', () => {
    const before = makeState({ review: { kind: 'unreviewed' } });
    const saved = editorReducer(before, { type: 'save-succeeded', revision: 8, reviewed: false });
    expect(isSaved(saved)).toBe(true);
    expect(isSaved(editorReducer(saved, { type: 'select-point', id: secondId }))).toBe(true);
    const blank = editorReducer(saved, { type: 'new' });
    expect(blank.savedSnapshotKey).toBe(saved.savedSnapshotKey);
    expect(isSaved(blank)).toBe(false);
    const imported = editorReducer(blank, { type: 'import-draft', draft: saved.draft });
    expect(imported.revision).toBe(10);
    expect(imported.savedSnapshotKey).toBe(saved.savedSnapshotKey);
    expect(isSaved(imported)).toBe(true);
  });

  it('compares identical source values independently of object property order', () => {
    const saved = editorReducer(makeState({ review: { kind: 'unreviewed' } }), {
      type: 'save-succeeded', revision: 8, reviewed: false,
    });
    const draft = {
      takeoff: { longitude: '-122.4200', latitude: '37.7740' },
      framing: { pitch: '-45', heading: '90', kind: 'fixed' },
      height: '30',
      points: [
        { coordinate: { longitude: '-122.4194', latitude: '37.7749' }, id: firstId },
        { coordinate: { longitude: '-122.4184', latitude: '37.7759' }, id: secondId },
      ],
      name: 'Survey route',
    } satisfies EditorState['draft'];
    const imported = editorReducer(saved, { type: 'import-draft', draft });
    expect(isSaved(imported)).toBe(true);
  });

  it('loads unreviewed source as a saved baseline and resets editing controls', () => {
    const draft = makeDraft({ name: 'Loaded', height: '-' });
    const next = expectSourceChange(makeState({ tool: 'add-points' }), { type: 'load-draft', draft, reviewed: false });
    expect(next.draft).toEqual(draft);
    expect(next.selectedPointId).toBeNull();
    expect(next.tool).toBe('select');
    expect(isSaved(next)).toBe(true);
  });
});
