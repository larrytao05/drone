import { useReducer } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentTurn } from '../../src/agent.js';
import { missionChangeSchema, previewMissionChange } from '../../src/agent-contract.js';
import { ProposalReview } from '../../web/ProposalReview.js';
import {
  captureAgentRequest, createEditorSession, editorSessionReducer, prepareAgentRequest,
  type EditorSession,
} from '../../web/editor-session.js';
import { makeDraft } from './fixtures.js';

type ModelResponse = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
const toolCall = (toolName: string, input: unknown, toolCallId: string) => ({
  type: 'tool-call', toolName, input: JSON.stringify(input), toolCallId,
} satisfies ModelResponse['content'][number]);
const modelResponse = (content: ModelResponse['content']): ModelResponse => ({
  content, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
  usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
});
function previewId(prompt: unknown) {
  const id = JSON.stringify(prompt).match(/"previewId":"([^"\\]+)"/)?.[1];
  if (!id) throw new Error('Expected a valid preview ID in the model prompt');
  return id;
}

async function proposalSession(height = 35, faceTarget = false) {
  let session = editorSessionReducer(createEditorSession('mount'), {
    type: 'import-route', missionBranchId: 'route', draft: makeDraft({
      height: '030.0',
      ...(faceTarget ? { framing: { kind: 'face-target', coordinate: { latitude: '37.7760', longitude: '-122.4170' }, height: '4' } } : {}),
    }),
  });
  const capture = captureAgentRequest(session, { requestId: 'proposal-1', message: 'Raise route height' });
  if (capture.kind !== 'ready') throw new Error('Expected a valid route');
  session = editorSessionReducer(session, { type: 'register-request', capture: capture.capture });
  const request = await prepareAgentRequest(capture.capture, () => session);
  if (request === null) throw new Error('Expected a prepared request');
  session = editorSessionReducer(session, { type: 'begin-request', capture: capture.capture, request });
  session = editorSessionReducer(session, { type: 'receive-response', response: {
    requestId: request.requestId,
    binding: request.binding,
    outcome: { kind: 'proposed', change: { kind: 'set-height', heightAboveTakeoffM: height }, activity: [] },
  } });
  return session;
}

function Harness({ initial }: Readonly<{ initial: EditorSession }>) {
  const [session, dispatch] = useReducer(editorSessionReducer, initial);
  return <>
    <button type="button" onClick={() => {
      dispatch({ type: 'edit', action: { type: 'set-height', value: '' } });
      dispatch({ type: 'apply-proposal', requestId: 'proposal-1' });
    }}>Invalidate then apply</button>
    <button type="button" onClick={() => dispatch({ type: 'apply-proposal', requestId: 'proposal-1' })}>Repeat apply</button>
    <ProposalReview session={session} dispatch={dispatch} />
    <span aria-label="Draft height">{session.editor.draft.height}</span>
    <span aria-label="Draft revision">{session.editor.revision}</span>
  </>;
}

describe('proposal review', () => {
  afterEach(cleanup);
  it('shows calculated height and face-target camera effects without changing the draft; Dismiss only clears review', async () => {
    const initial = await proposalSession(35, true);
    const originalPoints = initial.editor.draft.points.map(({ id, coordinate }) => [id, coordinate.latitude, coordinate.longitude]);
    render(<Harness initial={initial} />);

    const comparison = screen.getByRole('table', { name: 'Waypoint height and camera pitch comparison' });
    const rows = within(comparison).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const firstRow = within(rows[1]!).getAllByRole('cell').map((cell) => cell.textContent);
    expect(firstRow.slice(0, 3)).toEqual(['01', '30', '35']);
    expect(within(rows[1]!).getAllByRole('cell')[3]?.textContent).not.toBe(within(rows[1]!).getAllByRole('cell')[4]?.textContent);
    expect(screen.getByText(/Waypoint positions stay the same/)).toBeTruthy();
    expect(screen.getByLabelText('Draft height').textContent).toBe('030.0');
    expect(screen.getByRole('button', { name: 'Apply proposed change' }).getAttribute('disabled')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('heading', { name: 'Review height change' })).toBeNull();
    expect(screen.getByLabelText('Draft height').textContent).toBe('030.0');
    expect(initial.editor.draft.points.map(({ id, coordinate }) => [id, coordinate.latitude, coordinate.longitude])).toEqual(
      originalPoints,
    );
  });

  it('keeps a stale proposal visible and disabled, and the reducer rejects an apply queued after an edit', async () => {
    const initial = await proposalSession();
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Invalidate then apply' }));

    expect(screen.getByRole('status').textContent).toContain('out of date');
    expect(screen.getByRole('button', { name: 'Apply proposed change' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Draft height').textContent).toBe('');
    expect(screen.queryByText(/Waypoint positions stay the same/)).toBeNull();
  });

  it('opens the visual review from a real agent proposal and applies only after confirmation', async () => {
    let session = editorSessionReducer(createEditorSession('mount'), {
      type: 'import-route', missionBranchId: 'route', draft: makeDraft({ height: '20' }),
    });
    const capture = captureAgentRequest(session, { requestId: 'proposal-1', message: 'Raise this route to 40 meters' });
    if (capture.kind !== 'ready') throw new Error('Expected a valid route');
    session = editorSessionReducer(session, { type: 'register-request', capture: capture.capture });
    const request = await prepareAgentRequest(capture.capture, () => session);
    if (request === null) throw new Error('Expected a prepared request');
    session = editorSessionReducer(session, { type: 'begin-request', capture: capture.capture, request });

    const model = new MockLanguageModelV3({ doGenerate: async (options): Promise<ModelResponse> => {
      if (options.toolChoice?.type === 'required') {
        return modelResponse([toolCall('propose_change', { previewId: previewId(options.prompt) }, 'proposal')]);
      }
      return modelResponse([toolCall('preview_change', { kind: 'set-height', heightAboveTakeoffM: 40 }, 'preview')]);
    } });
    const outcome = await runAgentTurn({ message: request.message, snapshot: request.snapshot, binding: request.binding }, {
      model, changeSchema: missionChangeSchema,
      describeSnapshot: async () => ({ shotKind: 'route', heightAboveTakeoffM: 20, waypointCount: 2 }),
      previewChange: async (snapshot, change) => previewMissionChange(snapshot, change),
    });
    expect(outcome.kind).toBe('proposed');
    if (outcome.kind !== 'proposed') throw new Error('Expected a proposal');
    session = editorSessionReducer(session, { type: 'receive-response', response: {
      requestId: request.requestId, binding: request.binding,
      outcome: { kind: 'proposed', change: outcome.change, activity: outcome.activity },
    } });
    const { container } = render(<Harness initial={session} />);

    const comparison = within(container).getByRole('table', { name: 'Waypoint height and camera pitch comparison' });
    const rows = within(comparison).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getAllByRole('cell').slice(0, 3).map((cell) => cell.textContent)).toEqual(['01', '20', '40']);
    expect(within(rows[2]!).getAllByRole('cell').slice(0, 3).map((cell) => cell.textContent)).toEqual(['02', '20', '40']);
    expect(within(container).getByRole('button', { name: 'Apply proposed change' }).hasAttribute('disabled')).toBe(false);
    expect(within(container).getByLabelText('Draft height').textContent).toBe('20');

    fireEvent.click(within(container).getByRole('button', { name: 'Apply proposed change' }));
    expect(within(container).getByLabelText('Draft height').textContent).toBe('40');
    expect(within(container).queryByRole('heading', { name: 'Review height change' })).toBeNull();
  });

  it('applies exactly once through the session reducer and preserves no-op formatting', async () => {
    const initial = await proposalSession();
    const { container } = render(<Harness initial={initial} />);
    fireEvent.click(within(container).getByRole('button', { name: 'Apply proposed change' }));
    expect(within(container).getByLabelText('Draft height').textContent).toBe('35');
    expect(Number(within(container).getByLabelText('Draft revision').textContent)).toBe(initial.editor.revision + 1);
    expect(within(container).queryByRole('heading', { name: 'Review height change' })).toBeNull();
    expect(container.querySelectorAll('[aria-labelledby="proposal-review-title"]')).toHaveLength(0);
    fireEvent.click(within(container).getByRole('button', { name: 'Repeat apply' }));
    expect(Number(within(container).getByLabelText('Draft revision').textContent)).toBe(initial.editor.revision + 1);

    const noop = await proposalSession(30);
    const noopView = render(<Harness initial={noop} />);
    expect(within(noopView.container).getByRole('status').textContent).toContain('preserve the current formatting');
    fireEvent.click(within(noopView.container).getByRole('button', { name: 'Apply proposed change' }));
    expect(within(noopView.container).getByLabelText('Draft height').textContent).toBe('030.0');
  });
});
