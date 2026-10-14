import { describe, expect, it } from 'vitest';
import {
  analyseDraft,
  createEditorState,
  editorReducer,
  type EditorState,
  type MissionDraft,
} from '../../web/editor.js';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

const blankDraft = {
  name: '',
  points: [],
  height: '',
  framing: { kind: 'unselected' },
  takeoff: null,
} satisfies MissionDraft;

const reviewedDraft = {
  name: 'Survey route',
  points: [
    { id: firstId, coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
    { id: secondId, coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
  ],
  height: '30',
  framing: { kind: 'fixed', heading: '90', pitch: '-45' },
  takeoff: { latitude: '37.7740', longitude: '-122.4200' },
} satisfies MissionDraft;

function reviewedState(draft: MissionDraft = reviewedDraft): EditorState {
  return {
    ...createEditorState(),
    draft,
    revision: 8,
    review: { kind: 'reviewed', revision: 8 },
    selectedPointId: firstId,
    tool: 'add-points',
  };
}

describe('New route', () => {
  it('starts with blank source and default editor controls', () => {
    const state = createEditorState();

    expect(state.draft).toEqual(blankDraft);
    expect(state.tool).toBe('select');
    expect(state.selectedPointId).toBeNull();
    expect(state.review).toEqual({ kind: 'unreviewed' });
  });

  it('clears a populated reviewed draft and resets selection and tool', () => {
    const before = reviewedState();
    const next = editorReducer(before, { type: 'new' });

    expect(next.draft).toEqual(blankDraft);
    expect(next.selectedPointId).toBeNull();
    expect(next.tool).toBe('select');
    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(next.revision).toBe(before.revision + 1);
  });

  it('clears face-target source values', () => {
    const faceTargetDraft: MissionDraft = {
      ...reviewedDraft,
      framing: {
        kind: 'face-target',
        coordinate: { latitude: '37.776', longitude: '-122.418' },
        height: '45',
      },
    };

    expect(analyseDraft(faceTargetDraft).reviewEligible).toBe(true);

    const next = editorReducer(reviewedState(faceTargetDraft), { type: 'new' });

    expect(next.draft).toEqual(blankDraft);
    expect(next.draft.framing).toEqual({ kind: 'unselected' });
  });

  it('clears incomplete source values and stays blank on repeated New', () => {
    const incompleteDraft: MissionDraft = {
      ...reviewedDraft,
      points: [{ id: firstId, coordinate: { latitude: '-', longitude: '-122.4194' } }],
      height: '-',
      framing: { kind: 'fixed', heading: '-', pitch: '45' },
      takeoff: { latitude: '37.7740', longitude: '-' },
    };
    const incompleteState: EditorState = {
      ...reviewedState(incompleteDraft),
      review: { kind: 'unreviewed' },
    };
    const firstNew = editorReducer(incompleteState, { type: 'new' });
    const repeatedNew = editorReducer(firstNew, { type: 'new' });

    expect(firstNew.draft).toEqual(blankDraft);
    expect(repeatedNew.draft).toEqual(blankDraft);
  });

  it('does not calculate an empty route or make it review-eligible', () => {
    const analysis = analyseDraft(createEditorState().draft);

    expect(analysis.route.kind).toBe('not-calculated');
    expect(analysis.sourcePoints).toEqual([]);
    expect(analysis.takeoff).toBeNull();
    expect(analysis.reviewEligible).toBe(false);
  });

  it('derives no stale calculated output after New resets the source', () => {
    expect(analyseDraft(reviewedDraft).route.kind).toBe('calculated');

    const next = editorReducer(reviewedState(), { type: 'new' });
    const analysis = analyseDraft(next.draft);

    expect(analysis.route.kind).toBe('not-calculated');
    expect(analysis.sourcePoints).toEqual([]);
    expect(analysis.takeoff).toBeNull();
    expect(analysis.reviewEligible).toBe(false);
  });
});
