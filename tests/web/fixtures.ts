import type { EditorState, MissionDraft } from '../../web/editor.js';

export const firstId = '11111111-1111-4111-8111-111111111111';
export const secondId = '22222222-2222-4222-8222-222222222222';
export const thirdId = '33333333-3333-4333-8333-333333333333';

export function makePoints(count: number): MissionDraft['points'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    coordinate: { latitude: String(37.7749 + index / 10_000), longitude: '-122.4194' },
  }));
}

export function makeDraft(overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    name: 'Survey route',
    points: [
      { id: firstId, coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
      { id: secondId, coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
    ],
    height: '30',
    framing: { kind: 'fixed', heading: '90', pitch: '-45' },
    takeoff: { latitude: '37.7740', longitude: '-122.4200' },
    ...overrides,
  };
}

export function makeState(overrides: Partial<EditorState> = {}): EditorState {
  const revision = 8;
  return {
    draft: makeDraft(),
    revision,
    review: { kind: 'reviewed', revision },
    selectedPointId: firstId,
    tool: 'select',
    savedSnapshotKey: null,
    ...overrides,
  };
}
