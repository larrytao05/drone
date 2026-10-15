import { z } from 'zod';
import type { MissionDraft } from './editor';

const localDraftKey = 'drone.route-draft.v1';

const coordinateSchema = z.object({
  latitude: z.string(),
  longitude: z.string(),
}).strict().readonly();

const routePointSchema = z.object({
  id: z.string().uuid(),
  coordinate: coordinateSchema,
}).strict().readonly();

const framingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unselected') }).strict().readonly(),
  z.object({
    kind: z.literal('fixed'),
    heading: z.string(),
    pitch: z.string(),
  }).strict().readonly(),
  z.object({
    kind: z.literal('face-target'),
    coordinate: coordinateSchema,
    height: z.string(),
  }).strict().readonly(),
]);

const missionDraftSchema = z.object({
  name: z.string(),
  points: z.array(routePointSchema).readonly().superRefine((points, context) => {
    const ids = new Set<string>();
    points.forEach((point, index) => {
      if (ids.has(point.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Point IDs must be unique.',
        });
      }
      ids.add(point.id);
    });
  }),
  height: z.string(),
  framing: framingSchema,
  takeoff: coordinateSchema.nullable(),
}).strict().readonly();

const localDraftSchema = z.object({
  version: z.literal(1),
  draft: missionDraftSchema,
  reviewed: z.boolean(),
}).strict().readonly();

const backupSchema = z.object({
  version: z.literal(1),
  draft: missionDraftSchema,
}).strict().readonly();

export type BackupDecodeResult =
  | Readonly<{ ok: true; value: MissionDraft }>
  | Readonly<{ ok: false; issues: readonly z.ZodIssue[] }>;

export function encodeBackup(draft: MissionDraft): string {
  return JSON.stringify({ version: 1, draft });
}

export function decodeBackup(text: string): BackupDecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ code: 'custom', path: [], message: 'Backup is not valid JSON.' }] };
  }

  const parsed = backupSchema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  return { ok: true, value: parsed.data.draft };
}

export type StorageLike = Readonly<{
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}>;

export type LocalReadResult =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'invalid'; issues: readonly z.ZodIssue[] }>
  | Readonly<{ kind: 'inaccessible'; message: string }>
  | Readonly<{ kind: 'success'; draft: MissionDraft; reviewed: boolean }>;

export type LocalWriteResult =
  | Readonly<{ kind: 'success' }>
  | Readonly<{ kind: 'failure'; message: string }>;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : 'Local storage is unavailable.';
}

function parseStoredValue(raw: string): LocalReadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      kind: 'invalid',
      issues: [{ code: 'custom', path: [], message: 'Stored draft is not valid JSON.' }],
    };
  }

  const parsed = localDraftSchema.safeParse(value);
  if (!parsed.success) return { kind: 'invalid', issues: parsed.error.issues };

  const draft: MissionDraft = parsed.data.draft;
  return { kind: 'success', draft, reviewed: parsed.data.reviewed };
}

export function readLocalDraft(storage: StorageLike): LocalReadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(localDraftKey);
  } catch (error) {
    return { kind: 'inaccessible', message: messageFromError(error) };
  }
  if (raw === null) return { kind: 'absent' };
  return parseStoredValue(raw);
}

export function writeLocalDraft({
  storage,
  draft,
  reviewed,
}: Readonly<{ storage: StorageLike; draft: MissionDraft; reviewed: boolean }>): LocalWriteResult {
  try {
    const value = JSON.stringify({ version: 1, draft, reviewed });
    if (value === undefined) return { kind: 'failure', message: 'Draft could not be serialized.' };
    storage.setItem(localDraftKey, value);
    return { kind: 'success' };
  } catch (error) {
    return { kind: 'failure', message: messageFromError(error) };
  }
}
