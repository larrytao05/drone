import { describe, expect, it } from 'vitest';
import { makeDraft } from './fixtures.js';
import { encodeBackup, readLocalDraft, writeLocalDraft } from '../../web/draft-storage.js';

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

  it('reports malformed stored data without exposing a partial draft', () => {
    const storage = new MemoryStorage();
    writeLocalDraft({ storage, draft: makeDraft(), reviewed: false });
    const [slot] = storage.values.keys();
    if (!slot) throw new Error('Write did not populate a storage slot');
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
      const [key] = storage.values.keys();
      if (!key) throw new Error('Write did not populate a storage slot');
      storage.values.set(key, JSON.stringify(invalid));

      expect(readLocalDraft(storage).kind).toBe('invalid');
    }
  });

  it('reports inaccessible reads and failed quota writes', () => {
    const unreadable = new MemoryStorage();
    unreadable.failRead = true;
    expect(readLocalDraft(unreadable).kind).toBe('inaccessible');

    const unwritable = new MemoryStorage();
    unwritable.failWrite = true;
    expect(writeLocalDraft({ storage: unwritable, draft: makeDraft(), reviewed: false }).kind).toBe('failure');
    expect(unwritable.writes).toBe(1);
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
    expect(encodeBackup(draft)).toContain('"latitude":""');
  });
});
