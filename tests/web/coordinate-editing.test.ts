import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../src/index.js';
import {
  analyseDraft,
  createEditorState,
  editorReducer,
  type EditorState,
  type MissionDraft,
  type RoutePoint,
} from '../../web/editor.js';

type CoordinateEditCase = {
  field: keyof RoutePoint['coordinate'];
  value: string;
  expected: Coordinate;
};

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const staleId = '99999999-9999-4999-8999-999999999999';

const firstPoint: RoutePoint = {
  id: firstId,
  coordinate: { latitude: '37.7749', longitude: '-122.4194' },
};
const secondPoint: RoutePoint = {
  id: secondId,
  coordinate: { latitude: '37.7759', longitude: '-122.4184' },
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
    draft: structuredClone(draft),
    revision: 8,
    review: { kind: 'reviewed', revision: 8 },
    selectedPointId: firstId,
  };
}

describe('Coordinate editing', () => {
  it.each([
    { field: 'latitude', value: '37.8', expected: { latitudeDeg: 37.8, longitudeDeg: -122.4194 } },
    { field: 'longitude', value: '-122.4', expected: { latitudeDeg: 37.7749, longitudeDeg: -122.4 } },
  ] satisfies readonly CoordinateEditCase[])('edits only the selected point $field', ({ field, value, expected }) => {
    const before = reviewedState();
    const expectedDraft: MissionDraft = {
      ...structuredClone(before.draft),
      points: before.draft.points.map((point) =>
        point.id === firstId
          ? { ...point, coordinate: { ...point.coordinate, [field]: value } }
          : point,
      ),
    };
    const next = editorReducer(before, {
      type: 'set-point-coordinate',
      id: firstId,
      field,
      value,
    });

    expect(next.draft).toEqual(expectedDraft);
    expect(before.draft).toEqual(structuredClone(reviewedDraft));
    expect(next.draft.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(next.draft.points[1]).toEqual(secondPoint);
    expect(next.draft).toMatchObject({
      name: 'Survey route',
      height: '30',
      framing: { kind: 'fixed', heading: '90', pitch: '-45' },
      takeoff: { latitude: '37.7740', longitude: '-122.4200' },
    });
    const analysis = analyseDraft(next.draft);
    expect(analysis.route.kind).toBe('calculated');
    expect(analysis.sourcePoints).toEqual([
      { id: firstId, coordinate: expected },
      { id: secondId, coordinate: { latitudeDeg: 37.7759, longitudeDeg: -122.4184 } },
    ]);
    if (analysis.route.kind === 'calculated') {
      expect(analysis.route.waypoints[0]?.coordinate).toEqual(expected);
    }
  });

  it.each(['latitude', 'longitude'] as const)('%s retains each partial value through selection changes', (field) => {
    for (const value of ['', '-', '.', '1e']) {
      const before = reviewedState();
      const edited = editorReducer(before, {
        type: 'set-point-coordinate',
        id: firstId,
        field,
        value,
      });
      const away = editorReducer(edited, { type: 'select-point', id: secondId });
      const back = editorReducer(away, { type: 'select-point', id: firstId });

      expect(back.draft.points[0]?.coordinate[field]).toBe(value);
      expect(back.selectedPointId).toBe(firstId);
      expect(analyseDraft(back.draft).route.kind).toBe('not-calculated');
    }
  });

  it.each([
    { field: 'latitude', value: '.5', expected: { latitudeDeg: 0.5, longitudeDeg: -122.4194 } },
    { field: 'latitude', value: '1.', expected: { latitudeDeg: 1, longitudeDeg: -122.4194 } },
    { field: 'latitude', value: '3.77749e1', expected: { latitudeDeg: 37.7749, longitudeDeg: -122.4194 } },
    { field: 'longitude', value: '-1.224194e2', expected: { latitudeDeg: 37.7749, longitudeDeg: -122.4194 } },
    { field: 'longitude', value: '1e2', expected: { latitudeDeg: 37.7749, longitudeDeg: 100 } },
    { field: 'longitude', value: '.5', expected: { latitudeDeg: 37.7749, longitudeDeg: 0.5 } },
    { field: 'longitude', value: '1.', expected: { latitudeDeg: 37.7749, longitudeDeg: 1 } },
    { field: 'latitude', value: '1e1', expected: { latitudeDeg: 10, longitudeDeg: -122.4194 } },
    { field: 'latitude', value: '90', expected: { latitudeDeg: 90, longitudeDeg: -122.4194 } },
    { field: 'latitude', value: '-90', expected: { latitudeDeg: -90, longitudeDeg: -122.4194 } },
    { field: 'longitude', value: '180', expected: { latitudeDeg: 37.7749, longitudeDeg: 180 } },
    { field: 'longitude', value: '-180', expected: { latitudeDeg: 37.7749, longitudeDeg: -180 } },
  ] satisfies readonly CoordinateEditCase[])('calculates complete $field value $value without changing its source string', ({ field, value, expected }) => {
    const next = editorReducer(reviewedState(), {
      type: 'set-point-coordinate',
      id: firstId,
      field,
      value,
    });
    const analysis = analyseDraft(next.draft);

    expect(next.draft.points[0]?.coordinate[field]).toBe(value);
    expect(analysis.route.kind).toBe('calculated');
    expect(analysis.sourcePoints[0]).toEqual({ id: firstId, coordinate: expected });
    if (analysis.route.kind === 'calculated') {
      expect(analysis.route.waypoints[0]?.coordinate).toEqual(expected);
    }
  });

  it.each([
    { field: 'latitude', value: 'abc' },
    { field: 'latitude', value: '0x10' },
    { field: 'latitude', value: 'Infinity' },
    { field: 'longitude', value: 'NaN' },
    { field: 'latitude', value: 'NaN' },
    { field: 'longitude', value: 'abc' },
    { field: 'longitude', value: '0x10' },
    { field: 'longitude', value: 'Infinity' },
    { field: 'latitude', value: '90.0001' },
    { field: 'latitude', value: '-90.0001' },
    { field: 'longitude', value: '180.0001' },
    { field: 'longitude', value: '-180.0001' },
  ] satisfies readonly Pick<CoordinateEditCase, 'field' | 'value'>[])('keeps invalid $field source value $value and reports an issue without clamping', ({ field, value }) => {
    const next = editorReducer(reviewedState(), {
      type: 'set-point-coordinate',
      id: firstId,
      field,
      value,
    });
    const analysis = analyseDraft(next.draft);

    expect(next.draft.points[0]?.coordinate[field]).toBe(value);
    expect(analysis.route.kind).toBe('not-calculated');
    if (analysis.route.kind === 'not-calculated') {
      expect('waypoints' in analysis.route).toBe(false);
    }
    expect(analysis.sourcePoints.map((point) => point.id)).toEqual([secondId]);
    expect(analysis.reviewEligible).toBe(false);
    if (analysis.route.kind === 'not-calculated') {
      expect(analysis.route.issues.some((issue) => issue.pointId === firstId && issue.message.length > 0)).toBe(true);
    }
  });

  it('restores the source marker and calculated preview when an invalid value is corrected', () => {
    const invalid = editorReducer(reviewedState(), {
      type: 'set-point-coordinate',
      id: firstId,
      field: 'latitude',
      value: '90.0001',
    });
    const invalidAnalysis = analyseDraft(invalid.draft);
    expect(invalidAnalysis.route.kind).toBe('not-calculated');
    expect(invalidAnalysis.sourcePoints.map((point) => point.id)).toEqual([secondId]);

    const fixed = editorReducer(invalid, {
      type: 'set-point-coordinate',
      id: firstId,
      field: 'latitude',
      value: '37.8',
    });
    const fixedAnalysis = analyseDraft(fixed.draft);

    expect(fixedAnalysis.route.kind).toBe('calculated');
    expect(fixedAnalysis.sourcePoints.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(fixedAnalysis.sourcePoints[0]?.coordinate.latitudeDeg).toBe(37.8);
    expect(fixedAnalysis.reviewEligible).toBe(true);
  });

  it.each(['latitude', 'longitude'] as const)('clears review for a changed %s, but preserves it for the same text', (field) => {
    const before = reviewedState();
    const changed = editorReducer(before, {
      type: 'set-point-coordinate',
      id: firstId,
      field,
      value: field === 'latitude' ? '37.8' : '-122.4',
    });
    const unchanged = editorReducer(before, {
      type: 'set-point-coordinate',
      id: firstId,
      field,
      value: firstPoint.coordinate[field],
    });

    expect(changed.revision).toBe(9);
    expect(changed.review).toEqual({ kind: 'unreviewed' });
    expect(unchanged.revision).toBe(8);
    expect(unchanged.review).toEqual({ kind: 'reviewed', revision: 8 });
    expect(unchanged.draft).toEqual(before.draft);
  });

  it('ignores a stale point ID without changing source or review', () => {
    const before = reviewedState();
    const expectedDraft = structuredClone(before.draft);
    const next = editorReducer(before, {
      type: 'set-point-coordinate',
      id: staleId,
      field: 'latitude',
      value: '0',
    });

    expect(next.draft).toEqual(expectedDraft);
    expect(before.draft).toEqual(expectedDraft);
    expect(next.selectedPointId).toBe(firstId);
    expect(next.revision).toBe(8);
    expect(next.review).toEqual({ kind: 'reviewed', revision: 8 });
  });

  it('ignores a stale point ID on an empty draft', () => {
    const before = createEditorState();
    const next = editorReducer(before, {
      type: 'set-point-coordinate',
      id: staleId,
      field: 'latitude',
      value: '37.8',
    });

    expect(next).toEqual(before);
    expect(next.draft.points).toEqual([]);
  });
});
