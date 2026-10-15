import { describe, expect, it } from 'vitest';
import {
  analyseDraft,
  createEditorState,
  editorReducer,
  type EditorState,
  type MissionDraft,
  type RoutePoint,
} from '../../web/editor.js';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const thirdId = '33333333-3333-4333-8333-333333333333';

const firstPoint: RoutePoint = {
  id: firstId,
  coordinate: { latitude: '37.7749', longitude: '-122.4194' },
};
const secondPoint: RoutePoint = {
  id: secondId,
  coordinate: { latitude: '37.7759', longitude: '-122.4184' },
};
const thirdPoint: RoutePoint = {
  id: thirdId,
  coordinate: { latitude: '37.7769', longitude: '-122.4174' },
};

const reviewedDraft: MissionDraft = {
  name: 'Survey route',
  points: [firstPoint, secondPoint],
  height: '30',
  framing: { kind: 'fixed', heading: '90', pitch: '-45' },
  takeoff: { latitude: '37.7740', longitude: '-122.4200' },
};

const tools = ['select', 'add-points', 'set-takeoff', 'set-target'] satisfies readonly EditorState['tool'][];

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

describe('Add points', () => {
  it('appends exactly one point with the supplied coordinates to an empty route', () => {
    const point: RoutePoint = {
      id: firstId,
      coordinate: { latitude: '37.7749', longitude: '-122.4194' },
    };

    const next = editorReducer(createEditorState(), { type: 'append-point', point });

    expect(next.draft.points).toEqual([point]);
    expect(next.draft.points).toHaveLength(1);
  });

  it('appends repeated operations in order and leaves Add points active', () => {
    const start = editorReducer(createEditorState(), { type: 'set-tool', tool: 'add-points' });
    const afterFirst = editorReducer(start, { type: 'append-point', point: firstPoint });
    const afterSecond = editorReducer(afterFirst, { type: 'append-point', point: secondPoint });

    expect(afterSecond.draft.points).toEqual([firstPoint, secondPoint]);
    expect(afterSecond.tool).toBe('add-points');
  });

  it('preserves existing points and source fields when appending', () => {
    const before = reviewedState();
    const next = editorReducer(before, { type: 'append-point', point: thirdPoint });

    expect(next.draft.points).toEqual([firstPoint, secondPoint, thirdPoint]);
    expect(next.draft.points.slice(0, 2)).toEqual(before.draft.points);
    expect(next.draft).toMatchObject({
      name: 'Survey route',
      height: '30',
      framing: { kind: 'fixed', heading: '90', pitch: '-45' },
      takeoff: { latitude: '37.7740', longitude: '-122.4200' },
    });
  });

  it('keeps equal coordinates as separate points when their IDs differ', () => {
    const sameLocation: RoutePoint = {
      id: secondId,
      coordinate: { ...firstPoint.coordinate },
    };
    const afterFirst = editorReducer(createEditorState(), {
      type: 'append-point',
      point: firstPoint,
    });
    const next = editorReducer(afterFirst, { type: 'append-point', point: sameLocation });

    expect(next.draft.points).toEqual([firstPoint, sameLocation]);
    expect(next.draft.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(next.draft.points[0]?.coordinate).toEqual(next.draft.points[1]?.coordinate);
  });

  it('advances the source revision once and invalidates review after appending', () => {
    const next = editorReducer(reviewedState(), { type: 'append-point', point: thirdPoint });

    expect(next.revision).toBe(9);
    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(analyseDraft(next.draft).sourcePoints).toHaveLength(3);
  });

  it.each(tools)(
    'keeps the draft, source revision, review, and selected point when switching to %s',
    (tool) => {
      const before = reviewedState({
        ...reviewedDraft,
        framing: {
          kind: 'face-target',
          coordinate: { latitude: '37.776', longitude: '-122.418' },
          height: '45',
        },
      });

      const next = editorReducer(before, { type: 'set-tool', tool });

      expect(next.draft).toEqual(before.draft);
      expect(next.revision).toBe(before.revision);
      expect(next.review).toEqual(before.review);
      expect(next.selectedPointId).toBe(firstId);
      expect(next.tool).toBe(tool);
    },
  );
});
