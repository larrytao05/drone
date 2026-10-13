import { describe, expect, it } from 'vitest';
import { analyseDraft, editorReducer } from '../../web/editor.js';
import { planMission } from '../../src/index.js';
import { makeDraft, makeState } from './fixtures.js';

describe('Shared route settings', () => {
  it.each(['0', '-5', '.5', '1.', '1e2'])('applies finite height %s to every waypoint', (height) => {
    const next = editorReducer(makeState(), { type: 'set-height', value: height });
    expect(next.draft.height).toBe(height);
    const result = analyseDraft(next.draft);
    expect(result.route.kind).toBe('calculated');
    if (result.route.kind === 'calculated') expect(result.route.waypoints.map((point) => point.heightAboveTakeoffM)).toEqual([Number(height), Number(height)]);
  });
  it.each(['', '-', '.', '1e', '0x10', 'NaN', 'Infinity'])('keeps invalid height %j editable with no calculation', (height) => {
    const next = editorReducer(makeState(), { type: 'set-height', value: height });
    expect(next.draft.height).toBe(height);
    expect(analyseDraft(next.draft).route.kind).toBe('not-calculated');
  });
  it.each([
    { heading: '0', pitch: '-90', valid: true },
    { heading: '359.99', pitch: '90', valid: true },
    { heading: '360', pitch: '0', valid: false },
    { heading: '-1', pitch: '0', valid: false },
    { heading: '90', pitch: '-90.01', valid: false },
    { heading: '90', pitch: '90.01', valid: false },
    { heading: '', pitch: '0', valid: false },
    { heading: '90', pitch: 'NaN', valid: false },
  ])('uses planner limits for heading $heading and pitch $pitch', ({ heading, pitch, valid }) => {
    const analysis = analyseDraft(makeDraft({ framing: { kind: 'fixed', heading, pitch } }));
    expect(analysis.route.kind).toBe(valid ? 'calculated' : 'not-calculated');
    if (analysis.route.kind === 'calculated') for (const point of analysis.route.waypoints) {
      expect(point.headingDeg).toBe(Number(heading));
      expect(point.gimbalPitchDeg).toBe(Number(pitch));
    }
  });
  it('starts each new framing branch blank and discards old hidden values', () => {
    const before = makeState();
    const snapshot = structuredClone(before);
    expect(editorReducer(before, { type: 'set-framing', kind: 'fixed' })).toEqual(snapshot);
    const target = editorReducer(before, { type: 'set-framing', kind: 'face-target' });
    expect(target.draft.framing).toEqual({ kind: 'face-target', coordinate: { latitude: '', longitude: '' }, height: '' });
    const fixed = editorReducer(target, { type: 'set-framing', kind: 'fixed' });
    expect(fixed.draft.framing).toEqual({ kind: 'fixed', heading: '', pitch: '' });
    expect(editorReducer(fixed, { type: 'set-framing', kind: 'unselected' }).draft.framing).toEqual({ kind: 'unselected' });
  });
  it.each(['heading', 'pitch'] as const)('updates fixed %s without changing unrelated source', (field) => {
    const before = makeState();
    const snapshot = structuredClone(before);
    const value = field === 'heading' ? '180' : '-30';
    const next = editorReducer(before, { type: 'set-fixed-framing', field, value });
    expect(next.draft.framing).toEqual({ kind: 'fixed', heading: field === 'heading' ? value : '90', pitch: field === 'pitch' ? value : '-45' });
    expect({ ...next.draft, framing: snapshot.draft.framing }).toEqual(snapshot.draft);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.review).toEqual({ kind: 'unreviewed' });
    expect(editorReducer(before, { type: 'set-fixed-framing', field, value: field === 'heading' ? '90' : '-45' })).toEqual(snapshot);
    expect(before).toEqual(snapshot);
  });
  it('updates target height and raw coordinate fields independently', () => {
    const before = makeState({ draft: makeDraft({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' } }) });
    const snapshot = structuredClone(before);
    const moved = editorReducer(before, { type: 'set-target-coordinate', field: 'longitude', value: '-122.418' });
    expect(moved.draft.framing).toEqual({ kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.418' }, height: '10' });
    const partial = editorReducer(moved, { type: 'set-target-height', value: '1e' });
    expect(partial.draft.framing).toEqual({ kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.418' }, height: '1e' });
    expect(analyseDraft(partial.draft).route.kind).toBe('not-calculated');
    expect(analyseDraft(partial.draft).target).toEqual({ latitudeDeg: 37.776, longitudeDeg: -122.418 });
    const complete = editorReducer(partial, { type: 'set-target-height', value: '40' });
    expect(analyseDraft(complete.draft).route.kind).toBe('calculated');
    expect({ ...complete.draft, framing: snapshot.draft.framing }).toEqual(snapshot.draft);
    expect(complete.revision).toBe(before.revision + 3);
    expect(complete.review).toEqual({ kind: 'unreviewed' });
    expect(before).toEqual(snapshot);
    expect(analyseDraft(before.draft).target).toEqual({ latitudeDeg: 37.776, longitudeDeg: -122.419 });
    const invalidCoordinate = editorReducer(before, { type: 'set-target-coordinate', field: 'latitude', value: '-' });
    expect(analyseDraft(invalidCoordinate.draft).target).toBeNull();
  });
  it('leaves the target tool when leaving face-target framing', () => {
    const before = makeState({ draft: makeDraft({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' } }), tool: 'set-target' });
    expect(editorReducer(before, { type: 'set-framing', kind: 'fixed' }).tool).toBe('select');
  });
  it('changes target coordinates without changing target height, route or takeoff', () => {
    const before = makeState({ draft: makeDraft({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' } }) });
    const snapshot = structuredClone(before);
    const coordinate = { latitude: '37.777', longitude: '-122.418' };
    const next = editorReducer(before, { type: 'set-target', coordinate });
    expect(next.draft).toEqual({ ...snapshot.draft, framing: { kind: 'face-target', coordinate, height: '10' } });
    expect(next.revision).toBe(before.revision + 1);
    expect(next.review).toEqual({ kind: 'unreviewed' });
  });
  it.each(['fixed', 'unselected'] as const)('ignores inactive target edits in %s mode', (kind) => {
    const framing = kind === 'fixed' ? { kind, heading: '90', pitch: '-45' } : { kind };
    const before = makeState({ draft: makeDraft({ framing }) });
    const snapshot = structuredClone(before);
    expect(editorReducer(before, { type: 'set-target', coordinate: { latitude: '0', longitude: '0' } })).toEqual(snapshot);
    expect(editorReducer(before, { type: 'set-target-height', value: '0' })).toEqual(snapshot);
  });
  it('derives target headings and pitches from the real planner', () => {
    const draft = makeDraft({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' } });
    const expected = planMission({ shot: { kind: 'route', anchors: draft.points.map((point) => ({ latitudeDeg: Number(point.coordinate.latitude), longitudeDeg: Number(point.coordinate.longitude) })) }, heightAboveTakeoffM: 30, framing: { kind: 'face-target', target: { coordinate: { latitudeDeg: 37.776, longitudeDeg: -122.419 }, heightAboveTakeoffM: 10 } } });
    expect(analyseDraft(draft).route).toEqual(expected);
  });
  it.each(['set-name', 'set-height'] as const)('invalidates review for a changed %s but preserves it for identical text', (type) => {
    const before = makeState();
    const existing = type === 'set-name' ? before.draft.name : before.draft.height;
    expect(editorReducer(before, { type, value: existing })).toEqual(before);
    const next = editorReducer(before, { type, value: type === 'set-name' ? 'New name' : '40' });
    expect(next.revision).toBe(before.revision + 1);
    expect(next.review).toEqual({ kind: 'unreviewed' });
  });
});
