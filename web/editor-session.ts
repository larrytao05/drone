import {
  AGENT_SCHEMA_VERSION, PLANNER_VERSION, agentHistorySchema, agentMessageSchema,
  agentRequestSchema, agentResponseSchema, canonicalMissionInput, digestMissionInput,
  editorHeightChangeSchema, previewMissionChange,
  type AgentRequest, type AgentResponse,
} from '@drone/mission-planner/agent-contract';
import { analyseDraft } from './mission-input';
import { createEditorState, editorReducer, sourceFingerprint } from './editor';
import type { EditorAction, EditorState, MissionDraft } from './editor';

export type OrdinaryEditorAction = Exclude<EditorAction, { type: 'new' | 'import-draft' | 'load-draft' }>;

export type RequestCapture = Readonly<{
  requestId: string;
  message: string;
  history: AgentRequest['history'];
  snapshot: AgentRequest['snapshot'];
  missionBranchId: string;
  revision: number;
  sourceFingerprint: string;
  canonicalInput: string;
}>;

type RequestState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'hashing'; capture: RequestCapture }>
  | Readonly<{ kind: 'awaiting'; capture: RequestCapture; request: AgentRequest }>
  | Readonly<{ kind: 'finished'; requestId: string }>;

type Proposal = Readonly<{ capture: RequestCapture; response: AgentResponse }>;

export type EditorSession = Readonly<{
  editor: EditorState;
  missionBranchId: string;
  request: RequestState;
  proposal: Proposal | null;
}>;

export type EditorSessionAction =
  | Readonly<{ type: 'edit'; action: OrdinaryEditorAction }>
  | Readonly<{ type: 'new-route'; missionBranchId: string }>
  | Readonly<{ type: 'import-route'; missionBranchId: string; draft: MissionDraft }>
  | Readonly<{ type: 'load-route'; missionBranchId: string; draft: MissionDraft; reviewed: boolean }>
  | Readonly<{ type: 'register-request'; capture: RequestCapture }>
  | Readonly<{ type: 'begin-request'; capture: RequestCapture; request: AgentRequest }>
  | Readonly<{ type: 'receive-response'; response: unknown }>
  | Readonly<{ type: 'apply-proposal'; requestId: string }>
  | Readonly<{ type: 'dismiss-proposal'; requestId: string }>;

export function createEditorSession(missionBranchId: string): EditorSession {
  if (!missionBranchId) throw new Error('A mission branch ID is required.');
  return { editor: createEditorState(), missionBranchId, request: { kind: 'idle' }, proposal: null };
}

function matchesCapture(session: EditorSession, capture: RequestCapture): boolean {
  if (session.missionBranchId !== capture.missionBranchId || session.editor.revision !== capture.revision) return false;
  if (sourceFingerprint(session.editor.draft) !== capture.sourceFingerprint) return false;
  const route = analyseDraft(session.editor.draft).route;
  return route.kind === 'calculated' && canonicalMissionInput(route.input) === capture.canonicalInput;
}

export function captureAgentRequest(
  session: EditorSession,
  intent: Readonly<{ requestId: string; message: string; history?: AgentRequest['history'] }>,
): { kind: 'ready'; capture: RequestCapture } | { kind: 'invalid-draft' | 'invalid-request' } {
  const message = agentMessageSchema.safeParse(intent.message);
  const history = agentHistorySchema.safeParse(intent.history ?? []);
  if (!intent.requestId || intent.requestId.length > 128 || !message.success || !history.success) {
    return { kind: 'invalid-request' };
  }
  const route = analyseDraft(session.editor.draft).route;
  if (route.kind !== 'calculated') return { kind: 'invalid-draft' };
  return {
    kind: 'ready',
    capture: {
      requestId: intent.requestId, message: message.data, history: history.data,
      snapshot: route.input, missionBranchId: session.missionBranchId,
      revision: session.editor.revision, sourceFingerprint: sourceFingerprint(session.editor.draft),
      canonicalInput: canonicalMissionInput(route.input),
    },
  };
}

export async function prepareAgentRequest(
  capture: RequestCapture,
  currentSession: () => EditorSession,
): Promise<AgentRequest | null> {
  const inputDigest = await digestMissionInput(capture.snapshot);
  const current = currentSession();
  if (!matchesCapture(current, capture) || current.request.kind !== 'hashing'
    || current.request.capture !== capture) return null;
  const result = agentRequestSchema.safeParse({
    requestId: capture.requestId, message: capture.message, history: capture.history,
    snapshot: capture.snapshot,
    binding: {
      missionBranchId: capture.missionBranchId, revision: capture.revision, inputDigest,
      schemaVersion: AGENT_SCHEMA_VERSION, plannerVersion: PLANNER_VERSION,
    },
  });
  return result.success ? result.data : null;
}

function sameBinding(left: AgentRequest['binding'], right: AgentResponse['binding']): boolean {
  return left.missionBranchId === right.missionBranchId && left.revision === right.revision
    && left.inputDigest === right.inputDigest && left.schemaVersion === right.schemaVersion
    && left.plannerVersion === right.plannerVersion;
}

function matchesPrepared(capture: RequestCapture, request: AgentRequest): boolean {
  return request.requestId === capture.requestId && request.message === capture.message
    && JSON.stringify(request.history) === JSON.stringify(capture.history)
    && canonicalMissionInput(request.snapshot) === capture.canonicalInput
    && request.binding.missionBranchId === capture.missionBranchId
    && request.binding.revision === capture.revision
    && request.binding.schemaVersion === AGENT_SCHEMA_VERSION
    && request.binding.plannerVersion === PLANNER_VERSION;
}

export type ProposalInspection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'stale'; response: AgentResponse }>
  | Readonly<{ kind: 'ready'; response: AgentResponse; preview: Extract<ReturnType<typeof previewMissionChange>, { kind: 'valid' }>; numericNoOp: boolean }>;

export function inspectProposal(session: EditorSession): ProposalInspection {
  const proposal = session.proposal;
  if (proposal === null) return { kind: 'none' };
  const { capture, response } = proposal;
  if (!matchesCapture(session, capture)) return { kind: 'stale', response };
  if (response.outcome.kind !== 'proposed') return { kind: 'stale', response };
  const change = editorHeightChangeSchema.safeParse(response.outcome.change);
  const route = analyseDraft(session.editor.draft).route;
  if (!change.success || route.kind !== 'calculated' || route.input.shot.kind !== 'route') {
    return { kind: 'stale', response };
  }
  const preview = previewMissionChange(route.input, change.data);
  if (preview.kind !== 'valid') return { kind: 'stale', response };
  return {
    kind: 'ready', response, preview,
    numericNoOp: route.input.heightAboveTakeoffM === change.data.heightAboveTakeoffM,
  };
}

function replaceSession(session: EditorSession, editor: EditorState, missionBranchId: string): EditorSession {
  if (!missionBranchId || missionBranchId === session.missionBranchId) return session;
  return { editor, missionBranchId, request: { kind: 'idle' }, proposal: null };
}

export function editorSessionReducer(session: EditorSession, action: EditorSessionAction): EditorSession {
  switch (action.type) {
    case 'edit': {
      const editor = editorReducer(session.editor, action.action);
      if (editor === session.editor) return session;
      const sourceChanged = sourceFingerprint(editor.draft) !== sourceFingerprint(session.editor.draft);
      return {
        ...session, editor,
        request: sourceChanged && (session.request.kind === 'awaiting' || session.request.kind === 'hashing')
          ? { kind: 'idle' } : session.request,
      };
    }
    case 'new-route':
      return replaceSession(session, editorReducer(session.editor, { type: 'new' }), action.missionBranchId);
    case 'import-route':
      return replaceSession(session, editorReducer(session.editor, { type: 'import-draft', draft: action.draft }), action.missionBranchId);
    case 'load-route':
      return replaceSession(session, editorReducer(session.editor, { type: 'load-draft', draft: action.draft, reviewed: action.reviewed }), action.missionBranchId);
    case 'register-request': {
      if (!matchesCapture(session, action.capture)) return session;
      const activeId = session.request.kind === 'idle' ? null
        : session.request.kind === 'finished' ? session.request.requestId : session.request.capture.requestId;
      if (activeId === action.capture.requestId) return session;
      return { ...session, request: { kind: 'hashing', capture: action.capture }, proposal: null };
    }
    case 'begin-request': {
      if (session.request.kind !== 'hashing' || session.request.capture !== action.capture) return session;
      if (!matchesCapture(session, action.capture)) return session;
      const request = agentRequestSchema.safeParse(action.request);
      if (!request.success || !matchesPrepared(action.capture, request.data)) return session;
      return { ...session, request: { kind: 'awaiting', capture: action.capture, request: request.data } };
    }
    case 'receive-response': {
      if (session.request.kind !== 'awaiting') return session;
      const response = agentResponseSchema.safeParse(action.response);
      if (!response.success || response.data.requestId !== session.request.request.requestId
        || !sameBinding(session.request.request.binding, response.data.binding)
        || !matchesCapture(session, session.request.capture)) return session;
      const request = { kind: 'finished', requestId: response.data.requestId } satisfies RequestState;
      if (response.data.outcome.kind !== 'proposed') return { ...session, request };
      const change = editorHeightChangeSchema.safeParse(response.data.outcome.change);
      const route = analyseDraft(session.editor.draft).route;
      if (!change.success || route.kind !== 'calculated' || route.input.shot.kind !== 'route'
        || previewMissionChange(route.input, change.data).kind !== 'valid') return { ...session, request };
      return {
        ...session, request,
        proposal: { capture: session.request.capture, response: response.data },
      };
    }
    case 'apply-proposal': {
      if (session.proposal?.response.requestId !== action.requestId) return session;
      const inspection = inspectProposal(session);
      if (inspection.kind !== 'ready') return session;
      if (inspection.numericNoOp) return { ...session, proposal: null };
      const editor = editorReducer(session.editor, {
        type: 'set-height', value: String(inspection.preview.candidate.input.heightAboveTakeoffM),
      });
      return {
        ...session, editor, proposal: null,
        request: session.request.kind === 'hashing' || session.request.kind === 'awaiting'
          ? { kind: 'idle' } : session.request,
      };
    }
    case 'dismiss-proposal':
      return session.proposal?.response.requestId === action.requestId ? { ...session, proposal: null } : session;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
