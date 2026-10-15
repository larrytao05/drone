import { describe, expect, it } from 'vitest';
import { makeDraft } from './fixtures.js';
import { readLocalDraft, writeLocalDraft } from '../../web/draft-storage.js';

class MemoryStorage {
  values = new Map<string, string>();
  reads = 0;
  writes = 0;
  failRead = false;
  failWrite = false;

  getItem(key: string) {
    this.reads += 1;
    if (this.failRead) throw new DOMException('blocked', 'SecurityError');
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.writes += 1;
    if (this.failWrite) throw new DOMException('full', 'QuotaExceededError');
    this.values.set(key, value);
  }
}

function firstStoredKey(storage: MemoryStorage): string {
  const [key] = storage.values.keys();
  if (!key) throw new Error('Write did not populate a storage slot');
  return key;
}

function storePayload(storage: MemoryStorage, payload: unknown) {
  expect(writeLocalDraft({ storage, draft: makeDraft(), reviewed: false })).toEqual({ kind: 'success' });
  storage.values.set(firstStoredKey(storage), JSON.stringify(payload));
}

function firstPoint(draft: ReturnType<typeof makeDraft>) {
  const point = draft.points[0];
  if (!point) throw new Error('Fixture draft has no first point');
  return point;
}

describe('local draft storage', () => {
  it('distinguishes an absent slot without writing', () => {
    const storage = new MemoryStorage();

    expect(readLocalDraft(storage)).toEqual({ kind: 'absent' });
    expect(storage.writes).toBe(0);
  });

  it('reads a valid persisted draft and review bit', () => {
    const storage = new MemoryStorage();
    expect(writeLocalDraft({ storage, draft: makeDraft(), reviewed: true })).toEqual({ kind: 'success' });
    expect(storage.writes).toBe(1);

    expect(readLocalDraft(storage)).toEqual({ kind: 'success', draft: makeDraft(), reviewed: true });
  });

  it('writes the private versioned local shape exactly once', () => {
    const storage = new MemoryStorage();
    const draft = makeDraft();

    expect(writeLocalDraft({ storage, draft, reviewed: false })).toEqual({ kind: 'success' });
    const key = firstStoredKey(storage);
    const stored = storage.values.get(key);
    if (!stored) throw new Error('Storage slot is empty');

    expect(storage.writes).toBe(1);
    expect(JSON.parse(stored)).toEqual({ version: 1, draft, reviewed: false });
  });

  it('reports malformed stored data without exposing a partial draft', () => {
    const storage = new MemoryStorage();
    writeLocalDraft({ storage, draft: makeDraft(), reviewed: false });
    const slot = firstStoredKey(storage);
    storage.values.set(slot, '{');
    const writesBeforeRead = storage.writes;

    const result = readLocalDraft(storage);

    expect(result.kind).toBe('invalid');
    expect(storage.writes).toBe(writesBeforeRead);
  });

  it('rejects unknown versions, extra fields, and invalid source IDs in the local slot', () => {
    const valid = { version: 1, draft: makeDraft(), reviewed: false };
    const variants = [
      { ...valid, version: 2 },
      { ...valid, extra: true },
      { ...valid, reviewed: 'true' },
      { ...valid, draft: { ...valid.draft, points: [{ id: 'bad-id', coordinate: { latitude: '1', longitude: '2' } }] } },
    ];
    for (const invalid of variants) {
      const storage = new MemoryStorage();
      writeLocalDraft({ storage, draft: makeDraft(), reviewed: false });
      const key = firstStoredKey(storage);
      storage.values.set(key, JSON.stringify(invalid));

      expect(readLocalDraft(storage).kind).toBe('invalid');
    }
  });

  it.each([
    ['extra point property', (draft: ReturnType<typeof makeDraft>) => ({ ...draft, points: [{ ...firstPoint(draft), preview: [] }] })],
    ['extra nested coordinate property', (draft: ReturnType<typeof makeDraft>) => ({ ...draft, takeoff: { latitude: '37.7740', longitude: '-122.4200', altitude: '30' } })],
    ['duplicate point UUIDs', (draft: ReturnType<typeof makeDraft>) => ({ ...draft, points: [firstPoint(draft), firstPoint(draft)] })],
    ['extra active framing property', (draft: ReturnType<typeof makeDraft>) => ({ ...draft, framing: { kind: 'fixed', heading: '90', pitch: '-45', target: { latitude: '1', longitude: '2' } } })],
    ['inactive framing branch data', (draft: ReturnType<typeof makeDraft>) => ({ ...draft, framing: { kind: 'unselected', heading: '90' } })],
  ])('rejects %s without returning a partial draft', (_label, transform) => {
    const storage = new MemoryStorage();
    const draft = transform(makeDraft());
    storePayload(storage, { version: 1, draft, reviewed: false });

    const result = readLocalDraft(storage);

    expect(result.kind).toBe('invalid');
    expect(result).not.toHaveProperty('draft');
    if (result.kind === 'invalid') expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports inaccessible reads and failed quota writes', () => {
    const unreadable = new MemoryStorage();
    unreadable.failRead = true;
    expect(readLocalDraft(unreadable).kind).toBe('inaccessible');

    const unwritable = new MemoryStorage();
    writeLocalDraft({ storage: unwritable, draft: makeDraft(), reviewed: true });
    const slot = firstStoredKey(unwritable);
    const previousValue = unwritable.values.get(slot);
    unwritable.failWrite = true;
    expect(writeLocalDraft({ storage: unwritable, draft: makeDraft({ name: 'Replacement' }), reviewed: false }).kind).toBe('failure');
    expect(unwritable.writes).toBe(2);
    expect(unwritable.values.get(slot)).toBe(previousValue);
  });

  it('persists raw incomplete source strings unchanged', () => {
    const storage = new MemoryStorage();
    const draft = makeDraft({
      name: '',
      height: '-',
      points: [{ id: '11111111-1111-4111-8111-111111111111', coordinate: { latitude: '', longitude: '-' } }],
      framing: { kind: 'fixed', heading: '-', pitch: '' },
      takeoff: null,
    });
    writeLocalDraft({ storage, draft, reviewed: false });

    expect(readLocalDraft(storage)).toEqual({ kind: 'success', draft, reviewed: false });
  });
});
