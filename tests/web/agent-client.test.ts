import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_RETRY_WINDOW_MS, AGENT_SCHEMA_VERSION, PLANNER_VERSION, agentRequestSchema,
  digestMissionInput, type AgentRequest, type AgentResponse,
} from '../../src/agent-contract.js';
import type { MissionInput } from '../../src/index.js';
import { createAgentClient } from '../../web/agent-client.js';
import { createBrowserAgentHandlers } from '../../web/server/browser-agent.js';

const EPOCH = 'a'.repeat(32);
const SERVER_NOW = 1_800_000_000_000;
const snapshot: MissionInput = {
  shot: { kind: 'route', anchors: [{ latitudeDeg: 40, longitudeDeg: -70 }, { latitudeDeg: 40.001, longitudeDeg: -70.001 }] },
  heightAboveTakeoffM: 20,
  framing: { kind: 'fixed', headingDeg: 45, gimbalPitchDeg: -10 },
};
const binding = {
  missionBranchId: 'mission-branch', revision: 2, inputDigest: await digestMissionInput(snapshot),
  schemaVersion: AGENT_SCHEMA_VERSION, plannerVersion: PLANNER_VERSION,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bootstrap = () => json({ authenticated: true, epoch: EPOCH, serverNow: SERVER_NOW, retryWindowMs: AGENT_RETRY_WINDOW_MS });
function pending<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Uninitialised promise'); };
  let reject: (reason: unknown) => void = () => { throw new Error('Uninitialised promise'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let time = 0;
  let uuid = 0;
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createAgentClient({ fetch, now: () => time, uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` });
  const request = (): AgentRequest => agentRequestSchema.parse({
    requestId: client.createRequestId(), message: 'Change height', history: client.getState().history,
    snapshot: structuredClone(snapshot), binding,
  });
  const answer = (request: AgentRequest, text = 'Ready'): AgentResponse => ({ requestId: request.requestId, binding: { ...request.binding }, outcome: { kind: 'answered', text, activity: [] } });
  const signIn = async () => { fetch.mockResolvedValueOnce(bootstrap()); await client.session({ action: 'status' }); };
  return { client, fetch, request, answer, signIn, advance: (ms: number) => { time += ms; } };
}

describe('browser agent client', () => {
  it('bootstraps the cookie session, sends a coherent request and keeps bounded ephemeral history', async () => {
    const f = fixture();
    expect(f.client.createRequestId()).toBeNull();
    expect(f.client.getState()).toEqual({ session: { kind: 'unknown' }, turn: { kind: 'idle' }, history: [] });
    const listener = vi.fn();
    const unsubscribe = f.client.subscribe(listener);
    await f.signIn();
    const request = f.request();
    const reply = f.answer(request);
    f.fetch.mockResolvedValueOnce(json(reply));
    expect(await f.client.send(request)).toEqual(reply);
    expect(f.fetch).toHaveBeenNthCalledWith(1, '/api/agent/session', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{"action":"status"}' }));
    expect(f.fetch).toHaveBeenNthCalledWith(2, '/api/agent', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
    expect(f.client.getState().turn).toEqual({ kind: 'completed', response: reply });
    expect(f.client.getState().history).toEqual([{ role: 'user', content: 'Change height' }, { role: 'assistant', content: 'Ready' }]);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    f.client.reset();
    expect(listener).not.toHaveBeenCalled();
    expect(f.client.getState().history).toEqual([]);
    expect(f.client.getState().session.kind).toBe('authenticated');
  });

  it('cancels logically before abort and ignores a fetch that completes after cancellation', async () => {
    const f = fixture(); await f.signIn();
    const request = f.request();
    const delayed = pending<Response>();
    f.fetch.mockImplementationOnce((_url, init) => {
      init?.signal?.addEventListener('abort', () => expect(f.client.getState().turn.kind).not.toBe('completed'));
      return delayed.promise;
    });
    const sending = f.client.send(request);
    const signal = f.fetch.mock.calls[1]?.[1]?.signal;
    f.client.cancel();
    expect(signal?.aborted).toBe(true);
    expect(f.client.getState().turn.kind).toBe('cancelled');
    delayed.resolve(json(f.answer(request)));
    expect(await sending).toBeNull();
    expect(f.client.getState().turn.kind).toBe('cancelled');
    expect(await f.client.retry()).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores an older completion when a newer request has completed, even if abort is ignored', async () => {
    const f = fixture(); await f.signIn();
    const oldRequest = f.request(); const delayed = pending<Response>();
    f.fetch.mockReturnValueOnce(delayed.promise);
    const old = f.client.send(oldRequest);
    const currentRequest = f.request();
    const reply = f.answer(currentRequest, 'Current');
    f.fetch.mockResolvedValueOnce(json(reply));
    await f.client.send(currentRequest);
    delayed.resolve(json(f.answer(oldRequest, 'Old')));
    await old;
    expect(f.client.getState().turn).toEqual({ kind: 'completed', response: reply });
    expect(f.client.getState().history.at(-1)?.content).toBe('Current');
  });

  it('honours reset from a state subscriber before starting an effect', async () => {
    const f = fixture(); await f.signIn(); const request = f.request();
    const unsubscribe = f.client.subscribe(() => {
      if (f.client.getState().turn.kind === 'loading') f.client.reset();
    });
    expect(await f.client.send(request)).toBeNull();
    expect(f.client.getState().turn.kind).toBe('idle');
    expect(f.client.getState().history).toEqual([]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    unsubscribe();
    f.client.subscribe(() => {
      if (f.client.getState().session.kind === 'loading') f.client.reset();
    });
    await f.client.session({ action: 'status' });
    expect(f.client.getState().session.kind).toBe('unknown');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not send a duplicate logical request or reintroduce a completed result', async () => {
    const f = fixture(); await f.signIn();
    const request = f.request(); const delayed = pending<Response>();
    f.fetch.mockReturnValueOnce(delayed.promise);
    const first = f.client.send(request);
    expect(await f.client.send(request)).toBeNull();
    delayed.resolve(json(f.answer(request)));
    await first;
    expect(await f.client.send(request)).toBeNull();
    expect(await f.client.retry()).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.client.getState().history).toHaveLength(2);
  });

  it.each([
    { missionBranchId: 'another-branch' }, { revision: 3 }, { inputDigest: `sha256:${'b'.repeat(64)}` },
    { schemaVersion: '2' }, { plannerVersion: '2' },
  ])('rejects a response with a wrong binding %j', async (changed) => {
    const f = fixture(); await f.signIn(); const request = f.request();
    f.fetch.mockResolvedValueOnce(json({ ...f.answer(request), binding: { ...request.binding, ...changed } }));
    expect(await f.client.send(request)).toBeNull();
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', error: { kind: 'invalid-response' }, retryAvailable: false });
    expect(f.client.getState().history).toHaveLength(1);
  });

  it('rejects a wrong echoed request ID', async () => {
    const f = fixture(); await f.signIn(); const request = f.request();
    f.fetch.mockResolvedValueOnce(json({ ...f.answer(request), requestId: 'wrong-id' }));
    expect(await f.client.send(request)).toBeNull();
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', retryAvailable: false });
  });

  it.each([
    () => json({ kind: 'answered', text: 'Missing envelope' }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html>Proxy error</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    () => json({ unexpected: true, data: 'x'.repeat(33_000) }),
  ])('bounds and rejects malformed responses', async (response) => {
    const f = fixture(); await f.signIn(); const request = f.request(); f.fetch.mockResolvedValueOnce(response());
    expect(await f.client.send(request)).toBeNull();
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', error: { kind: 'invalid-response' }, retryAvailable: true });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects extra response fields under the strict shared schema', async () => {
    const f = fixture(); await f.signIn(); const request = f.request();
    f.fetch.mockResolvedValueOnce(json({ ...f.answer(request), candidate: snapshot }));
    expect(await f.client.send(request)).toBeNull();
  });

  it('cancels an oversized chunked response before reading any further chunks', async () => {
    const f = fixture(); await f.signIn(); const request = f.request(); const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(33_000)); }, cancel: cancelled });
    f.fetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'application/json' } }));
    expect(await f.client.send(request)).toBeNull();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels a response body waiting for more bytes', async () => {
    const f = fixture(); await f.signIn(); const request = f.request(); const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel: cancelled });
    f.fetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'application/json' } }));
    const sending = f.client.send(request);
    await vi.waitFor(() => expect(f.client.getState().turn.kind).toBe('loading'));
    await Promise.resolve();
    f.client.cancel();
    expect(await sending).toBeNull();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(f.client.getState().turn.kind).toBe('cancelled');
  });

  it('retries an ambiguous failure explicitly with exactly the same body and ID', async () => {
    const f = fixture(); await f.signIn(); const request = f.request(); const reply = f.answer(request);
    f.fetch.mockRejectedValueOnce(new TypeError('Disconnected'));
    await f.client.send(request);
    const sentBody = f.fetch.mock.calls[1]?.[1]?.body;
    Object.assign(request.snapshot, { heightAboveTakeoffM: 99 });
    request.message = 'Changed afterwards';
    request.binding.revision += 1;
    request.history.push({ role: 'user', content: 'Mutated history' });
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', error: { kind: 'network' }, retryAvailable: true });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.fetch.mockResolvedValueOnce(json(reply));
    expect(await f.client.retry()).toEqual(reply);
    expect(f.fetch.mock.calls[2]?.[1]?.body).toBe(sentBody);
    expect(f.client.getState().history).toHaveLength(2);
  });

  it.each([429, 502, 503])('allows explicit same-ID retry after an unbound HTTP %i error', async (status) => {
    const f = fixture(); await f.signIn(); const request = f.request();
    f.fetch.mockResolvedValueOnce(json({ kind: 'unavailable' }, status));
    await f.client.send(request);
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', error: { kind: 'http' }, retryAvailable: true });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403, 409, 413])('does not retry a rejected HTTP %i request', async (status) => {
    const f = fixture(); await f.signIn(); const request = f.request();
    f.fetch.mockResolvedValueOnce(json({ kind: 'rejected' }, status));
    await f.client.send(request);
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', retryAvailable: false });
    expect(await f.client.retry()).toBeNull();
  });

  it.each(['failed', 'deadline', 'budget-exceeded', 'unavailable', 'cancelled'] as const)('retains definitive %s results without silently inferring again', async (kind) => {
    const f = fixture(); await f.signIn(); const request = f.request();
    const response: AgentResponse = { requestId: request.requestId, binding: request.binding, outcome: { kind, activity: [] } };
    f.fetch.mockResolvedValueOnce(json(response, 502));
    expect(await f.client.send(request)).toEqual(response);
    expect(f.client.getState().turn).toEqual({ kind: 'completed', response });
    expect(await f.client.retry()).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const newAttempt = f.request();
    expect(newAttempt.requestId).not.toBe(request.requestId);
  });

  it('uses server time, conservative round-trip allowance and monotonic lease expiry', async () => {
    const f = fixture(); const delayed = pending<Response>(); f.fetch.mockReturnValueOnce(delayed.promise);
    const checking = f.client.session({ action: 'status' });
    f.advance(10_000); delayed.resolve(bootstrap()); await checking;
    f.advance(5_000);
    const request = f.request();
    expect(request.requestId.split('.')[1]).toBe(String(SERVER_NOW + 5_000));
    f.fetch.mockRejectedValueOnce(new Error('Lost response')); await f.client.send(request);
    f.advance(AGENT_RETRY_WINDOW_MS - 10_000);
    expect(await f.client.retry()).toBeNull();
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', error: { kind: 'retry-expired' }, retryAvailable: false });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not send a reserved capture after its lease expires', async () => {
    const f = fixture(); await f.signIn(); const request = f.request(); f.advance(AGENT_RETRY_WINDOW_MS);
    expect(await f.client.send(request)).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('reset clears an editor replacement, stale captures, history and retry state', async () => {
    const f = fixture(); await f.signIn(); const request = f.request(); const delayed = pending<Response>();
    f.fetch.mockReturnValueOnce(delayed.promise); const sending = f.client.send(request);
    f.client.reset();
    delayed.resolve(json(f.answer(request))); await sending;
    expect(f.client.getState()).toEqual({ session: { kind: 'authenticated' }, turn: { kind: 'idle' }, history: [] });
    expect(await f.client.retry()).toBeNull();
    expect(await f.client.send(request)).toBeNull();
    const capture = f.request(); f.client.reset();
    expect(await f.client.send(capture)).toBeNull();
  });

  it('reauthentication clears retry state and ignores an old session bootstrap', async () => {
    const f = fixture(); const delayed = pending<Response>(); f.fetch.mockReturnValueOnce(delayed.promise);
    const oldSession = f.client.session({ action: 'status' });
    f.fetch.mockResolvedValueOnce(json({ authenticated: false }));
    await f.client.session({ action: 'logout' }); delayed.resolve(bootstrap()); await oldSession;
    expect(f.client.getState().session.kind).toBe('unauthenticated');
    expect(f.client.createRequestId()).toBeNull();
    await f.signIn(); const request = f.request();
    f.fetch.mockRejectedValueOnce(new Error('Lost response')); await f.client.send(request);
    f.fetch.mockResolvedValueOnce(bootstrap()); await f.client.session({ action: 'login', password: 'fixture-password' });
    expect(await f.client.retry()).toBeNull();
    expect(await f.client.send(request)).toBeNull();
    expect(f.client.getState().history).toEqual([]);
    expect(f.fetch.mock.calls.at(-1)?.[1]?.body).toBe('{"action":"login","password":"fixture-password"}');
  });

  it('fails closed for a non-JSON unauthorized response', async () => {
    const f = fixture(); await f.signIn(); const request = f.request();
    f.fetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await f.client.send(request);
    expect(f.client.getState()).toMatchObject({ session: { kind: 'unauthenticated' }, turn: { kind: 'error', retryAvailable: false }, history: [] });
  });

  it('does not revive authentication after reset while a session check is pending', async () => {
    const f = fixture(); const delayed = pending<Response>(); f.fetch.mockReturnValueOnce(delayed.promise);
    const checking = f.client.session({ action: 'status' }); f.client.reset();
    delayed.resolve(bootstrap()); await checking;
    expect(f.client.getState().session.kind).toBe('unknown');
    expect(f.client.createRequestId()).toBeNull();
  });

  it('passes a proposed response through without applying it or creating assistant history', async () => {
    const f = fixture(); await f.signIn(); const request = f.request();
    const response: AgentResponse = { requestId: request.requestId, binding: request.binding, outcome: { kind: 'proposed', change: { kind: 'set-height', heightAboveTakeoffM: 30 }, activity: [] } };
    f.fetch.mockResolvedValueOnce(json(response));
    expect(await f.client.send(request)).toEqual(response);
    expect(snapshot.heightAboveTakeoffM).toBe(20);
    expect(f.client.getState().history).toEqual([{ role: 'user', content: 'Change height' }]);
  });

  it('adds a clarification question to ephemeral history', async () => {
    const f = fixture(); await f.signIn(); const request = f.request();
    const response: AgentResponse = { requestId: request.requestId, binding: request.binding, outcome: { kind: 'needs-input', question: 'Which height?', activity: [] } };
    f.fetch.mockResolvedValueOnce(json(response)); await f.client.send(request);
    expect(f.client.getState().history.at(-1)).toEqual({ role: 'assistant', content: 'Which height?' });
  });

  it('clears authentication and retry on a rejected chat session', async () => {
    const f = fixture(); await f.signIn(); const request = f.request();
    f.fetch.mockResolvedValueOnce(json({ kind: 'unauthorized' }, 401)); await f.client.send(request);
    expect(f.client.getState()).toMatchObject({ session: { kind: 'unauthenticated' }, turn: { kind: 'error', retryAvailable: false }, history: [] });
    expect(f.client.createRequestId()).toBeNull();
  });

  it.each([
    () => json({ authenticated: true, epoch: EPOCH, serverNow: SERVER_NOW, retryWindowMs: 999 }),
    () => json({ authenticated: true, epoch: 'invalid', serverNow: SERVER_NOW, retryWindowMs: AGENT_RETRY_WINDOW_MS }),
    () => json({ authenticated: false, secret: 'unexpected' }),
    () => json({ authenticated: false, padding: 'x'.repeat(2_000) }),
    () => new Response('<html>Unavailable</html>', { headers: { 'content-type': 'text/html' } }),
  ])('strictly bounds authentication responses and fails closed', async (response) => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(response()); await f.client.session({ action: 'status' });
    expect(f.client.getState().session).toMatchObject({ kind: 'error', error: { kind: 'invalid-response' } });
    expect(f.client.createRequestId()).toBeNull();
  });

  it('exposes session network errors and failed login without enabling requests', async () => {
    const f = fixture(); f.fetch.mockRejectedValueOnce(new Error('Offline')); await f.client.session({ action: 'status' });
    expect(f.client.getState().session).toMatchObject({ kind: 'error', error: { kind: 'network' } });
    f.fetch.mockResolvedValueOnce(json({ kind: 'unauthorized' }, 401)); await f.client.session({ action: 'login', password: 'incorrect' });
    expect(f.client.getState().session).toMatchObject({ kind: 'error', error: { kind: 'http' } });
    expect(f.client.createRequestId()).toBeNull();
  });

  it('rejects invalid and oversized captured requests before making a network call', async () => {
    const f = fixture(); await f.signIn(); const invalid = f.request(); invalid.message = '';
    expect(await f.client.send(invalid)).toBeNull();
    expect(f.client.getState().turn).toMatchObject({ kind: 'error', error: { kind: 'invalid-request' }, retryAvailable: false });
    const large = f.request(); large.history = Array.from({ length: 12 }, () => ({ role: 'user', content: 'x'.repeat(4_000) }));
    expect(await f.client.send(large)).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('replays the actual endpoint admission after its first response is lost', async () => {
    const origin = 'http://localhost:3105';
    const getModel = vi.fn(() => undefined);
    const handlers = createBrowserAgentHandlers({
      getEnvironment: () => ({ AGENT_LOGIN_PASSWORD: 'fixture-password', AGENT_SESSION_SECRET: 'fixture-signing-secret-with-32-characters', AGENT_ALLOWED_ORIGIN: origin }),
      getModel, epoch: EPOCH, now: () => SERVER_NOW,
    });
    let cookie = '';
    let loseResponse = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), origin);
      const headers = new Headers(init?.headers); headers.set('origin', origin);
      if (cookie) headers.set('cookie', cookie);
      const request = new Request(url, { ...init, headers });
      const response = await (url.pathname.endsWith('/session') ? handlers.session(request) : handlers.chat(request));
      cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? cookie;
      if (url.pathname === '/api/agent' && loseResponse) {
        loseResponse = false;
        throw new Error('Response lost after admission');
      }
      return response;
    };
    const client = createAgentClient({ fetch, now: () => 0, uuid: () => '00000000-0000-4000-8000-000000000001' });
    await client.session({ action: 'login', password: 'fixture-password' });
    const request = agentRequestSchema.parse({ requestId: client.createRequestId(), message: 'Change height', snapshot, binding });
    expect(await client.send(request)).toBeNull();
    expect(getModel).toHaveBeenCalledOnce();
    expect((await client.retry())?.outcome.kind).toBe('unavailable');
    expect(getModel).toHaveBeenCalledOnce();
    expect(await client.retry()).toBeNull();
  });

  it('keeps only the latest twelve ephemeral messages', async () => {
    const f = fixture(); await f.signIn();
    for (let index = 0; index < 8; index++) {
      const request = f.request(); f.fetch.mockResolvedValueOnce(json(f.answer(request, `Answer ${index}`))); await f.client.send(request);
    }
    expect(f.client.getState().history).toHaveLength(12);
    expect(f.client.getState().history.at(-1)?.content).toBe('Answer 7');
  });
});
