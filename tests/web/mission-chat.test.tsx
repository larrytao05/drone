import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { agentRequestSchema, agentSessionRequestSchema, type AgentRequest, type AgentResponse } from '../../src/agent-contract.js';
import { MissionEditor } from '../../web/MissionEditor.js';
import { encodeBackup, writeLocalDraft } from '../../web/draft-storage.js';
import { makeDraft } from './fixtures.js';
import type { MissionDraft } from '../../web/editor.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not ready'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function network(authenticated = true) {
  const requests: { request: AgentRequest; signal: AbortSignal | null | undefined; reply: (response: Response) => void }[] = [];
  const sessions: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (url === '/api/agent/session') {
      const action = agentSessionRequestSchema.parse(JSON.parse(String(init?.body)));
      sessions.push(action.action);
      if (action.action === 'logout') authenticated = false;
      if (action.action === 'login') {
        if (action.password !== 'route-password') return json({}, 401);
        authenticated = true;
      }
      return json(authenticated
        ? { authenticated: true, epoch: 'a'.repeat(32), serverNow: 1_800_000_000_000, retryWindowMs: 120_000 }
        : { authenticated: false });
    }
    const request = agentRequestSchema.parse(JSON.parse(String(init?.body)));
    const response = deferred<Response>();
    requests.push({ request, signal: init?.signal, reply: response.resolve });
    return response.promise;
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, sessions, fetch };
}
function proposed(request: AgentRequest, height = 40): AgentResponse {
  return { requestId: request.requestId, binding: request.binding, outcome: { kind: 'proposed', change: { kind: 'set-height', heightAboveTakeoffM: height }, activity: [] } };
}
function answered(request: AgentRequest, text = 'Route answer'): AgentResponse {
  return { requestId: request.requestId, binding: request.binding, outcome: { kind: 'answered', text, activity: [] } };
}
async function open(draft = makeDraft(), authenticated = true, reviewed = false) {
  const net = network(authenticated);
  writeLocalDraft({ storage: window.localStorage, draft, reviewed });
  render(<MissionEditor />);
  await screen.findByRole('button', { name: authenticated ? 'Sign out' : 'Sign in' });
  fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  return net;
}
async function send(net: ReturnType<typeof network>, message = 'Raise the height') {
  const count = net.requests.length;
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(net.requests).toHaveLength(count + 1));
  const request = net.requests[count];
  if (!request) throw new Error('Expected a request');
  return request;
}
async function reply(turn: Awaited<ReturnType<typeof send>>, response = proposed(turn.request)) {
  await act(async () => { turn.reply(json(response)); });
}
function importFile(draft: MissionDraft) {
  const file = new File([], 'route.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => encodeBackup(draft) });
  fireEvent.change(screen.getByLabelText('Import backup'), { target: { files: [file] } });
}
const height = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('mission chat integration', () => {
  it('sends a calculated route without takeoff and changes only height after explicit Apply without saving', async () => {
    const source = makeDraft({ height: '030.0', takeoff: null });
    const net = await open(source);
    const saved = window.localStorage.getItem(Object.keys(window.localStorage)[0] ?? '');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const turn = await send(net);
    expect(turn.request.snapshot.heightAboveTakeoffM).toBe(30);
    await reply(turn);
    expect(height().value).toBe('030.0');
    expect(screen.getByRole('table', { name: 'Waypoint height and camera pitch comparison' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply proposed change' }));
    expect(height().value).toBe('40');
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Not reviewed');
    expect(write).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(Object.keys(window.localStorage)[0] ?? '')).toBe(saved);
  });

  it('dismisses a proposal and preserves the source', async () => {
    const net = await open(); const turn = await send(net); await reply(turn);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(height().value).toBe('30');
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
  });

  it('keeps an invalidated proposal visible with Apply disabled and explains incomplete source', async () => {
    const net = await open(); const turn = await send(net); await reply(turn);
    fireEvent.change(height(), { target: { value: '-' } });
    expect(screen.getByText(/proposal is out of date/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply proposed change' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Complete the waypoint coordinates, height and framing/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });

  it('cancels a pending request on source edits and ignores its abort-ignoring reply', async () => {
    const net = await open(); const turn = await send(net);
    fireEvent.change(height(), { target: { value: '31' } });
    expect(turn.signal?.aborted).toBe(true);
    await reply(turn);
    expect(height().value).toBe('31');
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
  });

  it('cancels explicitly and admits only a newer response when replies finish out of order', async () => {
    const net = await open(); const old = await send(net, 'Old message');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    const current = await send(net, 'Current message');
    await reply(current, proposed(current.request, 45));
    await reply(old, answered(old.request, 'Late old answer'));
    expect(screen.queryByText('Late old answer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply proposed change' }));
    expect(height().value).toBe('45');
  });

  it.each(['New', 'Load', 'Import'] as const)('clears conversation and rejects a late reply after %s', async (action) => {
    const net = await open(); const turn = await send(net, 'Retired message');
    if (action === 'Import') { importFile(makeDraft({ name: 'Replacement' })); await screen.findByDisplayValue('Replacement'); }
    else fireEvent.click(screen.getByRole('button', { name: action }));
    await reply(turn, answered(turn.request, 'Retired answer'));
    expect(screen.queryByText('Retired message')).toBeNull();
    expect(screen.queryByText('Retired answer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
  });

  it('reaches the session endpoint for denied login, successful login, logout and re-login', async () => {
    const net = await open(makeDraft(), false);
    const password = screen.getByLabelText<HTMLInputElement>('Assistant password');
    expect(password.maxLength).toBe(256);
    fireEvent.change(password, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/Sign-in failed/);
    fireEvent.change(screen.getByLabelText('Assistant password'), { target: { value: 'route-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Sign out' });
    const turn = await send(net); await reply(turn);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Sign in' });
    expect(net.sessions).toEqual(['status', 'login', 'login', 'logout']);
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Assistant password'), { target: { value: 'route-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Sign out' });
    expect(net.sessions.at(-1)).toBe('login');
  });

  it('clears a pending request and conversation when authentication expires', async () => {
    const net = await open(); const turn = await send(net);
    await act(async () => { turn.reply(json({}, 401)); });
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('list', { name: 'Assistant conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
    expect(height().value).toBe('30');
  });

  it('retries a failed transport only explicitly with an identical request and accepts the resulting proposal', async () => {
    const net = await open(); const turn = await send(net);
    await act(async () => { turn.reply(json({}, 503)); });
    const retry = await screen.findByRole('button', { name: 'Retry same request' });
    expect(net.requests).toHaveLength(1);
    fireEvent.click(retry);
    await waitFor(() => expect(net.requests).toHaveLength(2));
    const retried = net.requests[1]; if (!retried) throw new Error('Expected retry');
    expect(retried.request).toEqual(turn.request);
    expect(net.fetch.mock.calls.at(-1)?.[1]?.body).toBe(net.fetch.mock.calls.at(-2)?.[1]?.body);
    await reply(retried);
    expect(screen.getByRole('button', { name: 'Apply proposed change' })).toBeTruthy();
  });

  it('shows a terminal provider failure without offering reinference through Retry', async () => {
    const net = await open(); const turn = await send(net);
    await reply(turn, { requestId: turn.request.requestId, binding: turn.request.binding, outcome: { kind: 'failed', message: 'get_mission_context internal failure', activity: [] } });
    expect(screen.getByText(/could not complete this request/)).toBeTruthy();
    expect(screen.queryByText(/internal failure/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
    expect(net.requests).toHaveLength(1);
  });

  it('renders answers and clarification as plain text and includes real history in the next send', async () => {
    const net = await open(); const first = await send(net, '<b>user</b>');
    await reply(first, answered(first.request, '<img src=x onerror=alert(1)>'));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    const second = await send(net, 'Clarify');
    expect(second.request.history).toEqual([{ role: 'user', content: '<b>user</b>' }, { role: 'assistant', content: '<img src=x onerror=alert(1)>' }]);
    await reply(second, { requestId: second.request.requestId, binding: second.request.binding, outcome: { kind: 'needs-input', question: 'Which height?', activity: [] } });
    expect(screen.getByText('Which height?')).toBeTruthy();
  });

  it('rejects a response with the wrong binding', async () => {
    const net = await open(); const turn = await send(net); const response = proposed(turn.request);
    await reply(turn, { ...response, binding: { ...response.binding, revision: response.binding.revision + 1 } });
    expect(screen.getByText(/response could not be verified/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
    expect(height().value).toBe('30');
  });

  it('preserves reviewed and saved raw formatting for a numerical no-op', async () => {
    const net = await open(makeDraft({ height: '030.0' }), true, true); const turn = await send(net);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    await reply(turn, proposed(turn.request, 30));
    fireEvent.click(screen.getByRole('button', { name: 'Apply proposed change' }));
    expect(height().value).toBe('030.0');
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Reviewed');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saved');
    expect(write).not.toHaveBeenCalled();
  });

  it('refreshes an already open save review after Apply without silently saving', async () => {
    const net = await open(); const turn = await send(net); await reply(turn);
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
      const element = originalCreate(tag, options);
      if (tag === 'dialog') Object.defineProperty(element, 'showModal', { value: () => element.setAttribute('open', '') });
      return element;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const apply = screen.getByRole('button', { name: 'Apply proposed change' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    act(() => { fireEvent.click(apply); fireEvent.click(confirm); });
    expect(screen.getByText(/route changed while review was open/)).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Unsaved');
  });
  it('reserves before hashing and prevents an old capture or cancellation from retiring newer work before render', async () => {
    const net = await open();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const firstHash = deferred<ArrayBuffer>();
    const secondHash = deferred<ArrayBuffer>();
    const digest = vi.spyOn(crypto.subtle, 'digest');
    digest.mockReturnValueOnce(firstHash.promise).mockReturnValueOnce(secondHash.promise);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Latest height' } });
    const form = screen.getByRole('textbox', { name: 'Message' }).closest('form');
    if (!form) throw new Error('Expected composer');
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeTruthy();
    const bytes = new TextEncoder().encode('hash');
    const hashed = await originalDigest('SHA-256', bytes);
    await act(async () => { firstHash.resolve(hashed); });
    expect(net.requests).toHaveLength(0);
    await act(async () => { secondHash.resolve(hashed); });
    await waitFor(() => expect(net.requests).toHaveLength(1));
    const turn = net.requests[0]; if (!turn) throw new Error('Expected latest request');
    await reply(turn);
    expect(screen.getByRole('button', { name: 'Apply proposed change' })).toBeTruthy();
  });

  it('cancels while hashing and never sends the late prepared request', async () => {
    const net = await open();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const hashing = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(hashing.promise);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Raise height' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await act(async () => { hashing.resolve(await originalDigest('SHA-256', new TextEncoder().encode('hash'))); });
    expect(net.requests).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
  });

  it('restarts an access check if New retires its initial bootstrap and ignores the old session reply', async () => {
    const net = network();
    const first = deferred<Response>();
    net.fetch.mockReturnValueOnce(first.promise);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByRole('button', { name: 'Sign out' });
    await act(async () => { first.resolve(json({ authenticated: false })); });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('clears only conversation and proposal state and rejects a late reply without replacing the draft', async () => {
    const net = await open(); const turn = await send(net, 'Clear this conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }));
    await reply(turn, answered(turn.request, 'Cleared late reply'));
    expect(height().value).toBe('30');
    expect(screen.queryByRole('list', { name: 'Assistant conversation' })).toBeNull();
    expect(screen.queryByText('Cleared late reply')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    const current = await send(net, 'New conversation');
    expect(current.request.history).toEqual([]);
  });

  it('explains a schema-valid change that the route editor cannot accept', async () => {
    const net = await open(); const turn = await send(net);
    await reply(turn, { requestId: turn.request.requestId, binding: turn.request.binding, outcome: { kind: 'proposed', change: { kind: 'set-orbit-radius', radiusM: 50 }, activity: [] } });
    expect(screen.getByText(/proposed change cannot be applied/)).toBeTruthy();
    expect(height().value).toBe('30');
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
  });

});
