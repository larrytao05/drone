import { describe, expect, it } from 'vitest';
import { analyseDraft, editorReducer } from '../../web/editor.js';
import { makeDraft, makeState } from './fixtures.js';

describe('Separate takeoff source', () => {
  it('changes takeoff and review while preserving every calculated waypoint', () => {
    const before = makeState();
    const snapshot = structuredClone(before);
    const coordinate = { latitude: '37.78', longitude: '-122.43' };
    const next = editorReducer(before, { type: 'set-takeoff', coordinate });
    expect(next.draft).toEqual({ ...snapshot.draft, takeoff: coordinate });
    expect(analyseDraft(next.draft).route).toEqual(analyseDraft(snapshot.draft).route);
    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(next.revision).toBe(before.revision + 1);
    expect(before).toEqual(snapshot);
  });
  it.each([null, { latitude: '', longitude: '' }, { latitude: '-', longitude: '0' }, { latitude: '91', longitude: '0' }])('allows preview but blocks review for takeoff %j', (takeoff) => {
    const analysis = analyseDraft(makeDraft({ takeoff }));
    expect(analysis.route.kind).toBe('calculated');
    expect(analysis.reviewEligible).toBe(false);
    expect(analysis.takeoff).toBeNull();
  });
  it('requires both a valid route and a valid takeoff for review', () => {
    expect(analyseDraft(makeDraft()).reviewEligible).toBe(true);
    expect(analyseDraft(makeDraft({ height: '' })).reviewEligible).toBe(false);
  });
  it('clears takeoff without removing a route point and treats identical input as a no-op', () => {
    const before = makeState();
    expect(editorReducer(before, { type: 'set-takeoff', coordinate: before.draft.takeoff })).toEqual(before);
    const next = editorReducer(before, { type: 'set-takeoff', coordinate: null });
    expect(next.draft.takeoff).toBeNull();
    expect(next.draft.points).toEqual(before.draft.points);
  });
});
