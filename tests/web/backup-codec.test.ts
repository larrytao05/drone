import { describe, expect, it } from 'vitest';
import { makeDraft } from './fixtures.js';
import { decodeBackup, encodeBackup } from '../../web/draft-storage.js';

describe('versioned JSON backups', () => {
  it('encodes only editable source and round-trips complete source', () => {
    const draft = makeDraft();
    const encoded = encodeBackup(draft);

    expect(JSON.parse(encoded)).toEqual({ version: 1, draft });
    expect(decodeBackup(encoded)).toEqual({ ok: true, value: draft });
  });

  it('round-trips incomplete raw text without coercion', () => {
    const draft = makeDraft({
      name: '', height: '3.',
      points: [{ id: '11111111-1111-4111-8111-111111111111', coordinate: { latitude: '-', longitude: '' } }],
      framing: { kind: 'fixed', heading: '', pitch: '-.' },
      takeoff: null,
    });

    expect(decodeBackup(encodeBackup(draft))).toEqual({ ok: true, value: draft });
  });

  it.each([
    ['invalid JSON', '{'],
    ['primitive root', '5'],
    ['array root', '[]'],
    ['unknown version', JSON.stringify({ version: 2, draft: makeDraft() })],
    ['missing version', JSON.stringify({ draft: makeDraft() })],
    ['string version', JSON.stringify({ version: '1', draft: makeDraft() })],
    ['extra root key', JSON.stringify({ version: 1, draft: makeDraft(), reviewed: true })],
    ['missing draft', JSON.stringify({ version: 1 })],
    ['wrong draft name type', JSON.stringify({ version: 1, draft: { ...makeDraft(), name: 42 } })],
    ['extra draft key', JSON.stringify({ version: 1, draft: { ...makeDraft(), preview: [] } })],
    ['duplicate point IDs', JSON.stringify({ version: 1, draft: { ...makeDraft(), points: [makeDraft().points[0], makeDraft().points[0]] } })],
    ['malformed point UUID', JSON.stringify({ version: 1, draft: { ...makeDraft(), points: [{ ...makeDraft().points[0], id: 'point-1' }] } })],
    ['wrong coordinate primitive', JSON.stringify({ version: 1, draft: { ...makeDraft(), points: [{ ...makeDraft().points[0], coordinate: { latitude: 37, longitude: '-122' } }] } })],
    ['unknown framing branch', JSON.stringify({ version: 1, draft: { ...makeDraft(), framing: { kind: 'orbit' } } })],
    ['empty UUID', JSON.stringify({ version: 1, draft: { ...makeDraft(), points: [{ id: '', coordinate: { latitude: '0', longitude: '0' } }] } })],
    ['extra coordinate key', JSON.stringify({ version: 1, draft: { ...makeDraft(), takeoff: { latitude: '0', longitude: '0', elevation: '20' } } })],
    ['missing numeric source field', JSON.stringify({ version: 1, draft: { ...makeDraft(), framing: { kind: 'fixed', heading: '90' } } })],
    ['inactive framing data', JSON.stringify({ version: 1, draft: { ...makeDraft(), framing: { kind: 'unselected', heading: '90' } } })],
  ])('rejects %s', (_label, text) => {
    const result = decodeBackup(text);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('value');
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
  it('round-trips face-target fields, source order and UUIDs exactly', () => {
    const draft = makeDraft({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '1e' } });
    expect(decodeBackup(encodeBackup(draft))).toEqual({ ok: true, value: draft });
  });
});
