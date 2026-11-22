import { describe, expect, it, vi } from 'vitest';
import { AGENT_SCHEMA_VERSION, PLANNER_VERSION } from '../../src/agent-contract.js';
import {
  captureAgentRequest, createEditorSession, editorSessionReducer, inspectProposal, prepareAgentRequest,
  type EditorSession,
} from '../../web/editor-session.js';
import { isSaved, sourceFingerprint } from '../../web/editor.js';
import { firstId, makeDraft, secondId } from './fixtures.js';

function routeSession(branch = 'branch-a'): EditorSession {
  return editorSessionReducer(createEditorSession(branch), {
    type: 'import-route', missionBranchId: `${branch}-import`,
    draft: makeDraft({ height: '030.0', name: 'Raw source' }),
  });
}

async function awaiting(session: EditorSession, requestId = 'request-1') {
  const result = captureAgentRequest(session, { requestId, message: 'Change the height' });
  if (result.kind !== 'ready') throw new Error('Expected a calculated route');
  session = editorSessionReducer(session, { type: 'register-request', capture: result.capture });
  const request = await prepareAgentRequest(result.capture, () => session);
  if (request === null) throw new Error('Expected a current request');
  return {
    request,
    session: editorSessionReducer(session, { type: 'begin-request', capture: result.capture, request }),
  };
}

function response(request: Awaited<ReturnType<typeof awaiting>>['request'], height = 35) {
  return {
    requestId: request.requestId, binding: request.binding,
    outcome: { kind: 'proposed', change: { kind: 'set-height', heightAboveTakeoffM: height }, activity: [] },
  };
}

describe('editor proposal acceptance', () => {
  it('rotates branch identity on every replacement, including blank New and identical imported content', () => {
    const blank = createEditorSession('mount-1');
    const newBlank = editorSessionReducer(blank, { type: 'new-route', missionBranchId: 'new-1' });
    expect(newBlank.editor).toBe(blank.editor);
    expect(newBlank.missionBranchId).toBe('new-1');
    const imported = editorSessionReducer(newBlank, { type: 'import-route', missionBranchId: 'import-1', draft: makeDraft() });
    const again = editorSessionReducer(imported, { type: 'import-route', missionBranchId: 'import-2', draft: makeDraft() });
    expect(again.missionBranchId).toBe('import-2');
    const loaded = editorSessionReducer(again, { type: 'load-route', missionBranchId: 'load-1', draft: makeDraft(), reviewed: true });
    expect(loaded.missionBranchId).toBe('load-1');
    expect(loaded.editor.review.kind).toBe('reviewed');
    expect(createEditorSession('mount-2').missionBranchId).not.toBe(blank.missionBranchId);
  });

  it('captures one raw and numeric source, and drops a digest completed after an edit', async () => {
    let session = routeSession();
    const result = captureAgentRequest(session, { requestId: 'race', message: '  Raise the route  ' });
    if (result.kind !== 'ready') throw new Error('Expected a calculated route');
    expect(result.capture.message).toBe('Raise the route');
    expect(result.capture.snapshot.heightAboveTakeoffM).toBe(30);
    expect(result.capture.canonicalInput).toContain('30');
    session = editorSessionReducer(session, { type: 'register-request', capture: result.capture });
    const preparing = prepareAgentRequest(result.capture, () => session);
    session = editorSessionReducer(session, { type: 'edit', action: { type: 'set-name', value: 'Changed during digest' } });
    expect(await preparing).toBeNull();
    expect(session.request.kind).toBe('idle');
  });

  it('does not let an older digest registration supersede the latest request', async () => {
    let session = routeSession();
    const older = captureAgentRequest(session, { requestId: 'older', message: 'Raise it' });
    const newer = captureAgentRequest(session, { requestId: 'newer', message: 'Lower it' });
    if (older.kind !== 'ready' || newer.kind !== 'ready') throw new Error('Expected captures');
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const releases: Array<() => void> = [];
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((algorithm, data) => new Promise((resolve, reject) => {
      releases.push(() => { void realDigest(algorithm, data).then(resolve, reject); });
    }));
    try {
      session = editorSessionReducer(session, { type: 'register-request', capture: older.capture });
      const late = prepareAgentRequest(older.capture, () => session);
      session = editorSessionReducer(session, { type: 'register-request', capture: newer.capture });
      const current = prepareAgentRequest(newer.capture, () => session);
      releases[1]?.();
      const request = await current;
      if (request === null) throw new Error('Expected latest request');
      session = editorSessionReducer(session, { type: 'begin-request', capture: newer.capture, request });
      releases[0]?.();
      expect(await late).toBeNull();
      expect(session.request).toMatchObject({ kind: 'awaiting', request: { requestId: 'newer' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects changed source, old sessions, wrong request IDs and every mismatched binding field', async () => {
    const original = routeSession();
    const { session, request } = await awaiting(original);
    const proposed = response(request);
    const wrong = [
      { ...proposed, requestId: 'other' },
      ...Object.entries({ missionBranchId: 'other', revision: request.binding.revision + 1,
        inputDigest: `sha256:${'0'.repeat(64)}`, schemaVersion: 'other', plannerVersion: 'other' })
        .map(([key, value]) => ({ ...proposed, binding: { ...request.binding, [key]: value } })),
    ];
    for (const reply of wrong) {
      expect(editorSessionReducer(session, { type: 'receive-response', response: reply })).toBe(session);
    }
    const unsupported = editorSessionReducer(session, { type: 'receive-response', response: {
      ...proposed, outcome: { ...proposed.outcome, change: { kind: 'set-orbit-radius', radiusM: 40 } },
    } });
    expect(unsupported.proposal).toBeNull();
    expect(unsupported.request.kind).toBe('finished');
    const selected = editorSessionReducer(session, { type: 'edit', action: { type: 'select-point', id: secondId } });
    const withTool = editorSessionReducer(selected, { type: 'edit', action: { type: 'set-tool', tool: 'add-points' } });
    expect(inspectProposal(editorSessionReducer(withTool, { type: 'receive-response', response: proposed })).kind).toBe('ready');
    const changed = editorSessionReducer(session, { type: 'edit', action: { type: 'set-name', value: 'Different source' } });
    expect(editorSessionReducer(changed, { type: 'receive-response', response: proposed })).toBe(changed);
    const replaced = editorSessionReducer(session, { type: 'load-route', missionBranchId: 'next', draft: original.editor.draft, reviewed: false });
    expect(editorSessionReducer(replaced, { type: 'receive-response', response: proposed })).toBe(replaced);
  });

  it('applies once through the editor source transition and leaves review of an open Save stale', async () => {
    const before = routeSession();
    const saved = editorSessionReducer(before, { type: 'edit', action: {
      type: 'save-succeeded', revision: before.editor.revision, reviewed: true,
    } });
    const openSaveRevision = saved.editor.revision;
    const { session, request } = await awaiting(saved);
    const withProposal = editorSessionReducer(session, { type: 'receive-response', response: response(request) });
    expect(inspectProposal(withProposal).kind).toBe('ready');
    const applied = editorSessionReducer(withProposal, { type: 'apply-proposal', requestId: request.requestId });
    expect(applied.editor.draft).toEqual({ ...saved.editor.draft, height: '35' });
    expect(applied.editor.draft.points.map((point) => point.id)).toEqual([firstId, secondId]);
    expect(applied.editor.revision).toBe(openSaveRevision + 1);
    expect(applied.editor.review.kind).toBe('unreviewed');
    expect(isSaved(applied.editor)).toBe(false);
    expect(openSaveRevision).not.toBe(applied.editor.revision);
    expect(editorSessionReducer(applied, { type: 'apply-proposal', requestId: request.requestId })).toBe(applied);
    expect(editorSessionReducer(applied, { type: 'receive-response', response: response(request) })).toBe(applied);
    expect(editorSessionReducer(applied, { type: 'edit', action: {
      type: 'save-succeeded', revision: openSaveRevision, reviewed: true,
    } })).toBe(applied);
  });

  it('consumes a numeric no-op without normalising raw height or changing review and save', async () => {
    const before = routeSession();
    const saved = editorSessionReducer(before, { type: 'edit', action: {
      type: 'save-succeeded', revision: before.editor.revision, reviewed: true,
    } });
    const { session, request } = await awaiting(saved);
    const withProposal = editorSessionReducer(session, { type: 'receive-response', response: response(request, 30) });
    expect(inspectProposal(withProposal)).toMatchObject({ kind: 'ready', numericNoOp: true });
    const applied = editorSessionReducer(withProposal, { type: 'apply-proposal', requestId: request.requestId });
    expect(applied.editor).toBe(saved.editor);
    expect(applied.editor.draft.height).toBe('030.0');
    expect(isSaved(applied.editor)).toBe(true);
    expect(applied.proposal).toBeNull();
    expect(editorSessionReducer(applied, { type: 'receive-response', response: response(request, 40) })).toBe(applied);
    const duplicate = captureAgentRequest(applied, { requestId: request.requestId, message: 'Change the height' });
    if (duplicate.kind !== 'ready') throw new Error('Expected a calculated route');
    expect(editorSessionReducer(applied, { type: 'register-request', capture: duplicate.capture })).toBe(applied);
  });

  it('keeps a displayed proposal stale after a raw source edit while UI actions leave it applicable', async () => {
    const { session, request } = await awaiting(routeSession());
    const displayed = editorSessionReducer(session, { type: 'receive-response', response: response(request) });
    const selected = editorSessionReducer(displayed, { type: 'edit', action: { type: 'select-point', id: secondId } });
    const tool = editorSessionReducer(selected, { type: 'edit', action: { type: 'set-tool', tool: 'add-points' } });
    expect(sourceFingerprint(tool.editor.draft)).toBe(sourceFingerprint(displayed.editor.draft));
    expect(inspectProposal(tool).kind).toBe('ready');
    const edited = editorSessionReducer(tool, { type: 'edit', action: { type: 'set-name', value: 'New name' } });
    expect(inspectProposal(edited).kind).toBe('stale');
    expect(edited.proposal).not.toBeNull();
    expect(editorSessionReducer(edited, { type: 'apply-proposal', requestId: request.requestId })).toBe(edited);
    const next = captureAgentRequest(displayed, { requestId: 'request-2', message: 'Change it again' });
    if (next.kind !== 'ready') throw new Error('Expected a new capture');
    const registered = editorSessionReducer(displayed, { type: 'register-request', capture: next.capture });
    expect(registered.proposal).toBeNull();
    expect(editorSessionReducer(registered, { type: 'apply-proposal', requestId: request.requestId })).toBe(registered);
  });

  it('does not admit a mismatched version or malformed request and limits Apply to route height', async () => {
    const before = routeSession();
    expect(captureAgentRequest(createEditorSession('empty'), { requestId: 'x', message: 'hello' }).kind).toBe('invalid-draft');
    expect(captureAgentRequest(before, { requestId: 'x', message: ' ' }).kind).toBe('invalid-request');
    const { session, request } = await awaiting(before);
    expect(request.binding.schemaVersion).toBe(AGENT_SCHEMA_VERSION);
    expect(request.binding.plannerVersion).toBe(PLANNER_VERSION);
    const invalid = editorSessionReducer(session, { type: 'receive-response', response: response(request, Number.NaN) });
    expect(invalid).toBe(session);
  });
});
