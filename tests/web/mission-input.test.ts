import { describe, expect, it } from 'vitest';
import { planMission } from '@drone/mission-planner';
import { analyseDraft, editorReducer } from '../../web/editor.js';
import type { MissionDraft } from '../../web/editor.js';
import { firstId, secondId, makeDraft, makeState } from './fixtures.js';

function expectUncalculated(draft: MissionDraft) {
  const analysis = analyseDraft(draft);
  expect(analysis.route.kind).toBe('not-calculated');
  expect(analysis.route).not.toHaveProperty('waypoints');
  expect(analysis.route).not.toHaveProperty('input');
  expect(analysis.reviewEligible).toBe(false);
  if (analysis.route.kind !== 'not-calculated') throw new Error('Expected an invalid draft');
  return analysis.route.issues;
}

describe('Source to planner adapter', () => {
  it.each([
    { text: '+.5', value: 0.5 },
    { text: '-.5', value: -0.5 },
    { text: '1.', value: 1 },
    { text: '+1.2E+2', value: 120 },
    { text: '-1e-2', value: -0.01 },
    { text: '  30\n', value: 30 },
    { text: '0', value: 0 },
    { text: '-5', value: -5 },
  ])('calculates height $text as $value and preserves source exactly', ({ text, value }) => {
    const draft = makeDraft({ height: text });
    const original = structuredClone(draft);
    expect(analyseDraft(draft).route).toEqual({
      kind: 'calculated',
      input: {
        shot: { kind: 'route', anchors: [
          { latitudeDeg: 37.7749, longitudeDeg: -122.4194 },
          { latitudeDeg: 37.7759, longitudeDeg: -122.4184 },
        ] },
        heightAboveTakeoffM: value,
        framing: { kind: 'fixed', headingDeg: 90, gimbalPitchDeg: -45 },
      },
      waypoints: [
        { coordinate: { latitudeDeg: 37.7749, longitudeDeg: -122.4194 }, heightAboveTakeoffM: value, headingDeg: 90, gimbalPitchDeg: -45 },
        { coordinate: { latitudeDeg: 37.7759, longitudeDeg: -122.4184 }, heightAboveTakeoffM: value, headingDeg: 90, gimbalPitchDeg: -45 },
      ],
    });
    expect(draft).toEqual(original);
  });

  it.each(['', ' ', '-', '+', '.', '1e', '1e+', '1e-', '0x10', '0b10', '0o10', '1_000', 'Infinity', '-Infinity', 'NaN', '1e309', '1 2'])('rejects incomplete or non-decimal height %j', (height) => {
    const draft = makeDraft({ height });
    expect(expectUncalculated(draft)).toEqual([
      { path: ['heightAboveTakeoffM'], code: 'malformed', message: 'Enter a complete finite decimal number.', field: 'height' },
    ]);
    expect(draft.height).toBe(height);
    expect(analyseDraft(draft).sourcePoints.map((point) => point.id)).toEqual([firstId, secondId]);
  });

  it('keeps coordinate markers independently of missing height, framing and target height', () => {
    const analysis = analyseDraft(makeDraft({ height: '', framing: { kind: 'face-target', coordinate: { latitude: '+37.776', longitude: '-122.419' }, height: '1e' } }));
    expect(analysis.sourcePoints).toEqual([
      { id: firstId, coordinate: { latitudeDeg: 37.7749, longitudeDeg: -122.4194 } },
      { id: secondId, coordinate: { latitudeDeg: 37.7759, longitudeDeg: -122.4184 } },
    ]);
    expect(analysis.target).toEqual({ latitudeDeg: 37.776, longitudeDeg: -122.419 });
    expect(analysis.takeoff).toEqual({ latitudeDeg: 37.774, longitudeDeg: -122.42 });
    expect(analysis.route.kind).toBe('not-calculated');
    expect(analysis.reviewEligible).toBe(false);
  });

  it('exposes the exact planner input and preserves raw source text and point identity/order', () => {
    const draft = makeDraft({
      height: '+3e1',
      points: [
        { id: secondId, coordinate: { latitude: '+37.7759', longitude: '-122.4184' } },
        { id: firstId, coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
      ],
      framing: { kind: 'fixed', heading: '9e1', pitch: '-4.5e1' },
    });
    const original = structuredClone(draft);
    const analysis = analyseDraft(draft);
    expect(analysis.route.kind).toBe('calculated');
    if (analysis.route.kind !== 'calculated') throw new Error('Expected a calculated route');
    const { input, ...calculation } = analysis.route;
    expect(input).toEqual({
      shot: { kind: 'route', anchors: [
        { latitudeDeg: 37.7759, longitudeDeg: -122.4184 },
        { latitudeDeg: 37.7749, longitudeDeg: -122.4194 },
      ] },
      heightAboveTakeoffM: 30,
      framing: { kind: 'fixed', headingDeg: 90, gimbalPitchDeg: -45 },
    });
    expect(planMission(input)).toEqual(calculation);
    expect(draft).toEqual(original);
    expect(analysis.sourcePoints.map(({ id }) => id)).toEqual([secondId, firstId]);
  });

  it('keeps a valid planner input available when takeoff independently blocks review', () => {
    const analysis = analyseDraft(makeDraft({ takeoff: null }));
    expect(analysis.route.kind).toBe('calculated');
    expect(analysis.reviewEligible).toBe(false);
    if (analysis.route.kind !== 'calculated') throw new Error('Expected a calculated route');
    expect(analysis.route.input).toEqual({
      shot: { kind: 'route', anchors: [
        { latitudeDeg: 37.7749, longitudeDeg: -122.4194 },
        { latitudeDeg: 37.7759, longitudeDeg: -122.4184 },
      ] },
      heightAboveTakeoffM: 30,
      framing: { kind: 'fixed', headingDeg: 90, gimbalPitchDeg: -45 },
    });
  });

  it.each([
    { latitude: '90', longitude: '180', valid: true },
    { latitude: '-90', longitude: '-180', valid: true },
    { latitude: '90.1', longitude: '180', valid: false },
    { latitude: '-90.1', longitude: '-180', valid: false },
    { latitude: '90', longitude: '180.1', valid: false },
    { latitude: '-90', longitude: '-180.1', valid: false },
    { latitude: '0b1', longitude: '0', valid: false },
    { latitude: '0', longitude: '1e309', valid: false },
  ])('checks source bounds before route readiness for $latitude,$longitude', ({ latitude, longitude, valid }) => {
    const coordinate = { latitude, longitude };
    const draft = makeDraft({ height: '', points: [{ id: firstId, coordinate }], takeoff: coordinate, framing: { kind: 'face-target', coordinate, height: '' } });
    const analysis = analyseDraft(draft);
    const expected = valid ? { latitudeDeg: Number(latitude), longitudeDeg: Number(longitude) } : null;
    expect(analysis.sourcePoints).toEqual(expected === null ? [] : [{ id: firstId, coordinate: expected }]);
    expect(analysis.target).toEqual(expected);
    expect(analysis.takeoff).toEqual(expected);
    expect(analysis.route.kind).toBe('not-calculated');
    expect(draft.points).toEqual([{ id: firstId, coordinate }]);
  });

  it.each([
    { heading: '0', pitch: '-90' },
    { heading: '359.99', pitch: '90' },
    { heading: '360', pitch: '0' },
    { heading: '-1', pitch: '0' },
    { heading: '90', pitch: '-90.01' },
    { heading: '90', pitch: '90.01' },
  ])('uses the public planner decision for heading $heading and pitch $pitch', ({ heading, pitch }) => {
    const result = planMission({ shot: { kind: 'route', anchors: [{ latitudeDeg: 37.7749, longitudeDeg: -122.4194 }, { latitudeDeg: 37.7759, longitudeDeg: -122.4184 }] }, heightAboveTakeoffM: 30, framing: { kind: 'fixed', headingDeg: Number(heading), gimbalPitchDeg: Number(pitch) } });
    const draft = makeDraft({ framing: { kind: 'fixed', heading, pitch } });
    const analysis = analyseDraft(draft);
    if (result.kind === 'calculated') {
      if (analysis.route.kind !== 'calculated') throw new Error('Expected a calculated route');
      const { input, ...calculation } = analysis.route;
      expect(planMission(input)).toEqual(calculation);
      expect(calculation).toEqual(result);
      expect(analysis.reviewEligible).toBe(true);
    } else {
      const issues = expectUncalculated(draft);
      expect(issues.map(({ path, code, message }) => ({ path, code, message }))).toEqual(result.issues);
      expect(issues.every((issue) => issue.pointId === undefined)).toBe(true);
    }
  });

  it.each([
    { latitude: '37.7749', longitude: '-122.4194', height: '0' },
    { latitude: '0', longitude: '0', height: '-5' },
    { latitude: '37.776', longitude: '-122.419', height: '-5' },
    { latitude: '37.776', longitude: '-122.419', height: '0' },
  ])('uses planner target geometry and height for $latitude,$longitude at $height metres', ({ latitude, longitude, height }) => {
    const result = planMission({ shot: { kind: 'route', anchors: [{ latitudeDeg: 37.7749, longitudeDeg: -122.4194 }, { latitudeDeg: 37.7759, longitudeDeg: -122.4184 }] }, heightAboveTakeoffM: -5, framing: { kind: 'face-target', target: { coordinate: { latitudeDeg: Number(latitude), longitudeDeg: Number(longitude) }, heightAboveTakeoffM: Number(height) } } });
    const draft = makeDraft({ height: '-5', framing: { kind: 'face-target', coordinate: { latitude, longitude }, height } });
    const analysis = analyseDraft(draft);
    expect(analysis.target).toEqual({ latitudeDeg: Number(latitude), longitudeDeg: Number(longitude) });
    if (result.kind === 'calculated') {
      if (analysis.route.kind !== 'calculated') throw new Error('Expected a calculated route');
      const { input, ...calculation } = analysis.route;
      expect(planMission(input)).toEqual(calculation);
      expect(calculation).toEqual(result);
      expect(analysis.reviewEligible).toBe(true);
    } else {
      expect(expectUncalculated(draft)).toEqual(result.issues);
    }
  });

  it('retains a polar source point while preserving the planner target-facing rejection', () => {
    const result = planMission({ shot: { kind: 'route', anchors: [{ latitudeDeg: 90, longitudeDeg: 0 }, { latitudeDeg: 89.999, longitudeDeg: 0 }] }, heightAboveTakeoffM: 30, framing: { kind: 'face-target', target: { coordinate: { latitudeDeg: 89.998, longitudeDeg: 0 }, heightAboveTakeoffM: 0 } } });
    const draft = makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '90', longitude: '0' } },
      { id: secondId, coordinate: { latitude: '89.999', longitude: '0' } },
    ], framing: { kind: 'face-target', coordinate: { latitude: '89.998', longitude: '0' }, height: '0' } });
    expect(result.kind).toBe('invalid-input');
    if (result.kind !== 'invalid-input') throw new Error('Expected unsupported polar heading');
    expect(expectUncalculated(draft)).toEqual(result.issues);
    expect(analyseDraft(draft).sourcePoints).toEqual([
      { id: firstId, coordinate: { latitudeDeg: 90, longitudeDeg: 0 } },
      { id: secondId, coordinate: { latitudeDeg: 89.999, longitudeDeg: 0 } },
    ]);
  });

  it('maps planner coordinate paths to the reordered source snapshot and specific fields', () => {
    const draft = makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '91', longitude: '0' } },
      { id: secondId, coordinate: { latitude: '0', longitude: '181' } },
    ] });
    const reordered = editorReducer(makeState({ draft }), { type: 'reorder-point', id: firstId, beforeId: null });
    const issues = expectUncalculated(reordered.draft);
    expect(issues.map(({ path, pointId, field }) => ({ path, pointId, field }))).toEqual([
      { path: ['shot', 'anchors', 0, 'longitudeDeg'], pointId: secondId, field: 'longitude' },
      { path: ['shot', 'anchors', 1, 'latitudeDeg'], pointId: firstId, field: 'latitude' },
    ]);
  });

  it('removes invalid preview data and restores only current values after correction', () => {
    const state = makeState();
    expect(analyseDraft(state.draft).route.kind).toBe('calculated');
    const invalid = editorReducer(state, { type: 'set-height', value: '1e' });
    expectUncalculated(invalid.draft);
    const corrected = editorReducer(invalid, { type: 'set-height', value: '1e2' });
    const route = analyseDraft(corrected.draft).route;
    expect(route.kind).toBe('calculated');
    if (route.kind !== 'calculated') throw new Error('Expected a corrected route');
    expect(route.waypoints.map((point) => point.heightAboveTakeoffM)).toEqual([100, 100]);
    expect(corrected.draft.height).toBe('1e2');
    expect(corrected.review).toEqual({ kind: 'unreviewed' });
  });
});
