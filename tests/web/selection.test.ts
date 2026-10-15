import { describe, expect, it } from 'vitest';
import {
  createEditorState,
  editorReducer,
  type EditorState,
  type MissionDraft,
  type RoutePoint,
} from '../../web/editor.js';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const staleId = '99999999-9999-4999-8999-999999999999';

const firstPoint: RoutePoint = {
  id: firstId,
  coordinate: { latitude: '37.7749', longitude: '-122.4194' },
};
const secondPoint: RoutePoint = {
  id: secondId,
  coordinate: { latitude: '51.5074', longitude: '-0.1278' },
};
const reviewedDraft: MissionDraft = {
  name: 'Survey route',
  points: [firstPoint, secondPoint],
  height: '30',
  framing: { kind: 'fixed', heading: '90', pitch: '-45' },
  takeoff: { latitude: '37.7740', longitude: '-122.4200' },
};

function reviewedState(draft: MissionDraft = reviewedDraft): EditorState {
  return {
    ...createEditorState(),
    draft,
    revision: 8,
    review: { kind: 'reviewed', revision: 8 },
    selectedPointId: firstId,
  };
}

describe('Waypoint selection', () => {
  it('selects a point by its stable ID without changing its source or review', () => {
    const before = reviewedState();
    const next = editorReducer(before, { type: 'select-point', id: secondId });

    expect(next.selectedPointId).toBe(secondId);
    expect(next.draft).toEqual(before.draft);
    expect(next.revision).toBe(8);
    expect(next.review).toEqual({ kind: 'reviewed', revision: 8 });
  });

  it('selects a valid point from a null selection without changing its source or review', () => {
    const before = { ...reviewedState(), selectedPointId: null };
    const next = editorReducer(before, { type: 'select-point', id: secondId });

    expect(next.selectedPointId).toBe(secondId);
    expect(next.draft).toEqual(before.draft);
    expect(next.revision).toBe(before.revision);
    expect(next.review).toEqual(before.review);
  });

  it('switches the selected ID while the previous point remains in the route', () => {
    const firstSelection = editorReducer(reviewedState(), {
      type: 'select-point',
      id: secondId,
    });
    const next = editorReducer(firstSelection, { type: 'select-point', id: firstId });

    expect(next.selectedPointId).toBe(firstId);
    expect(next.draft.points.map((point) => point.id)).toEqual([firstId, secondId]);
  });

  it('keeps points with duplicate coordinates independently selectable by ID', () => {
    const duplicate: RoutePoint = {
      id: secondId,
      coordinate: { ...firstPoint.coordinate },
    };
    const before = reviewedState({ ...reviewedDraft, points: [firstPoint, duplicate] });

    const firstSelection = editorReducer(before, { type: 'select-point', id: firstId });
    const secondSelection = editorReducer(firstSelection, { type: 'select-point', id: secondId });

    expect(secondSelection.selectedPointId).toBe(secondId);
    expect(secondSelection.draft.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(secondSelection.draft.points[0]?.coordinate).toEqual(
      secondSelection.draft.points[1]?.coordinate,
    );
  });

  it('preserves order, coordinates, settings, takeoff, revision and review', () => {
    const before = reviewedState();
    const expectedDraft = structuredClone(before.draft);
    const next = editorReducer(before, { type: 'select-point', id: secondId });

    expect(next.draft).toEqual(expectedDraft);
    expect(before.draft).toEqual(expectedDraft);
    expect(next.draft.name).toBe('Survey route');
    expect(next.draft.height).toBe('30');
    expect(next.draft.framing).toEqual({ kind: 'fixed', heading: '90', pitch: '-45' });
    expect(next.draft.takeoff).toEqual({ latitude: '37.7740', longitude: '-122.4200' });
    expect(next.revision).toBe(8);
    expect(next.review).toEqual({ kind: 'reviewed', revision: 8 });
  });

  it('leaves observable state unchanged when the same point is selected again', () => {
    const before = reviewedState();
    const next = editorReducer(before, { type: 'select-point', id: firstId });

    expect(next.selectedPointId).toBe(firstId);
    expect(next.draft).toEqual(before.draft);
    expect(next.revision).toBe(before.revision);
    expect(next.review).toEqual(before.review);
  });

  it('ignores a stale ID and retains an existing selection', () => {
    const before = reviewedState();
    const next = editorReducer(before, { type: 'select-point', id: staleId });

    expect(next.selectedPointId).toBe(firstId);
    expect(next.draft).toEqual(before.draft);
    expect(next.revision).toBe(8);
    expect(next.review).toEqual({ kind: 'reviewed', revision: 8 });
  });

  it('keeps an empty draft unselected when a stale ID is requested', () => {
    const before = createEditorState();
    const next = editorReducer(before, { type: 'select-point', id: staleId });

    expect(next.selectedPointId).toBeNull();
    expect(next.draft.points).toEqual([]);
    expect(next.revision).toBe(before.revision);
    expect(next.review).toEqual({ kind: 'unreviewed' });
  });
});
