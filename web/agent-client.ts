import {
  agentRequestSchema, agentResponseSchema, agentSessionRequestSchema, agentSessionResponseSchema,
  formatAgentRequestId, sameAgentBinding,
  type AgentRequest, type AgentResponse, type AgentSessionResponse,
} from '@drone/mission-planner/agent-contract';

type SessionAction = ReturnType<typeof agentSessionRequestSchema.parse>;
type Bootstrap = Extract<AgentSessionResponse, { authenticated: true }> & { startedAt: number; receivedAt: number };
type RequestLease = Readonly<{ requestId: string; deadline: number }>;
type RetryRequest = RequestLease & Readonly<{ body: string; binding: AgentRequest['binding'] }>;
export type AgentClientError = Readonly<{
  kind: 'network' | 'invalid-response' | 'http' | 'invalid-request' | 'retry-expired';
  message: string;
}>;
export type AgentClientState = Readonly<{
  session:
    | Readonly<{ kind: 'unknown' | 'loading' | 'authenticated' | 'unauthenticated' }>
    | Readonly<{ kind: 'error'; error: AgentClientError }>;
  turn:
    | Readonly<{ kind: 'idle' | 'cancelled' }>
    | Readonly<{ kind: 'loading'; requestId: string }>
    | Readonly<{ kind: 'completed'; response: AgentResponse }>
    | Readonly<{ kind: 'error'; error: AgentClientError; retryAvailable: boolean }>;
  history: ReadonlyArray<Readonly<AgentRequest['history'][number]>>;
}>;
type Options = Readonly<{
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
}>;

async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => {});
    throw new Error('Invalid response type');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Cancelled');
      const part = await reader.read();
      if (signal.aborted) throw new Error('Cancelled');
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        cancel();
        throw new Error('Response too large');
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function createAgentClient({ fetch: sendFetch = globalThis.fetch, now = () => performance.now(), uuid = () => crypto.randomUUID() }: Options = {}) {
  let state: AgentClientState = { session: { kind: 'unknown' }, turn: { kind: 'idle' }, history: [] };
  let bootstrap: Bootstrap | null = null;
  let reserved: RequestLease | null = null;
  let retryRequest: RetryRequest | null = null;
  let generation = 0;
  let chatAbort: AbortController | null = null;
  let sessionAbort: AbortController | null = null;
  const listeners = new Set<() => void>();

  function update(next: AgentClientState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function retire(): void {
    generation += 1;
    reserved = null;
    retryRequest = null;
    const chat = chatAbort;
    const session = sessionAbort;
    chatAbort = null;
    sessionAbort = null;
    chat?.abort();
    session?.abort();
  }

  function reset(): void {
    retire();
    update({ session: state.session.kind === 'loading' ? { kind: 'unknown' } : state.session, turn: { kind: 'idle' }, history: [] });
  }

  async function session(action: SessionAction): Promise<void> {
    const body = JSON.stringify(agentSessionRequestSchema.parse(action));
    retire();
    bootstrap = null;
    const controller = new AbortController();
    sessionAbort = controller;
    const current = generation;
    const startedAt = now();
    update({ session: { kind: 'loading' }, turn: { kind: 'idle' }, history: [] });
    let error: AgentClientError = { kind: 'network', message: 'Could not connect. Try signing in again.' };
    try {
      if (current !== generation || sessionAbort !== controller) return;
      const response = await sendFetch('/api/agent/session', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
      });
      error = { kind: 'invalid-response', message: 'The sign-in response could not be verified.' };
      const value = await readJson(response, 1_024, controller.signal);
      if (current !== generation || sessionAbort !== controller) return;
      if (!response.ok) {
        update({ ...state, session: { kind: 'error', error: { kind: 'http', message: response.status === 401 ? 'Sign-in failed. Check your password.' : 'Sign-in is unavailable. Try again later.' } } });
        return;
      }
      const parsed = agentSessionResponseSchema.safeParse(value);
      if (!parsed.success || (action.action === 'login' && !parsed.data.authenticated)
        || (action.action === 'logout' && parsed.data.authenticated)) throw new Error('Invalid session');
      bootstrap = parsed.data.authenticated ? { ...parsed.data, startedAt, receivedAt: now() } : null;
      update({ ...state, session: { kind: parsed.data.authenticated ? 'authenticated' : 'unauthenticated' } });
    } catch {
      if (current === generation && sessionAbort === controller) update({ ...state, session: { kind: 'error', error } });
    } finally {
      if (sessionAbort === controller) sessionAbort = null;
    }
  }

  function createRequestId(): string | null {
    if (!bootstrap || state.session.kind !== 'authenticated') return null;
    const at = now();
    const elapsed = Math.max(0, at - bootstrap.receivedAt);
    const createdAt = Math.floor(bootstrap.serverNow + elapsed);
    const requestId = formatAgentRequestId(bootstrap.epoch, createdAt, uuid());
    retire();
    reserved = { requestId, deadline: bootstrap.startedAt + (createdAt - bootstrap.serverNow) + bootstrap.retryWindowMs };
    update({ ...state, turn: { kind: 'idle' } });
    return requestId;
  }

  function fail(error: AgentClientError, request: RetryRequest | null): null {
    retryRequest = request && now() < request.deadline ? request : null;
    update({ ...state, turn: { kind: 'error', error, retryAvailable: retryRequest !== null } });
    return null;
  }

  async function run(request: RetryRequest, history = state.history): Promise<AgentResponse | null> {
    const controller = new AbortController();
    chatAbort = controller;
    const current = generation;
    retryRequest = null;
    update({ ...state, turn: { kind: 'loading', requestId: request.requestId }, history });
    let error: AgentClientError = { kind: 'network', message: 'The connection was interrupted. Retry can check the same request.' };
    try {
      if (current !== generation || chatAbort !== controller) return null;
      const response = await sendFetch('/api/agent', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: request.body, signal: controller.signal,
      });
      if (current !== generation || chatAbort !== controller) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      if (response.status === 401) {
        void response.body?.cancel().catch(() => {});
        bootstrap = null;
        retire();
        update({ session: { kind: 'unauthenticated' }, turn: { kind: 'error', error: { kind: 'http', message: 'Sign in again to use the assistant.' }, retryAvailable: false }, history: [] });
        return null;
      }
      error = { kind: 'invalid-response', message: 'The assistant response could not be verified.' };
      const value = await readJson(response, 32 * 1_024, controller.signal);
      if (current !== generation || chatAbort !== controller) return null;
      const parsed = agentResponseSchema.safeParse(value);
      if (parsed.success) {
        if (parsed.data.requestId !== request.requestId || !sameAgentBinding(parsed.data.binding, request.binding)) {
          return fail(error, null);
        }
        const outcome = parsed.data.outcome;
        const text = outcome.kind === 'answered' ? outcome.text : outcome.kind === 'needs-input' ? outcome.question : null;
        const history = text ? [...state.history, { role: 'assistant' as const, content: text }].slice(-12) : state.history;
        update({ ...state, turn: { kind: 'completed', response: parsed.data }, history });
        return current === generation && chatAbort === controller ? parsed.data : null;
      }
      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        return fail({ kind: 'http', message: retryable ? 'The assistant is unavailable. You can retry the same request.' : 'This request is unavailable. Start a new request or sign in again.' }, retryable ? request : null);
      }
      return fail(error, request);
    } catch {
      if (current !== generation || chatAbort !== controller) return null;
      return fail(error, request);
    } finally {
      if (chatAbort === controller) chatAbort = null;
    }
  }

  async function send(request: AgentRequest): Promise<AgentResponse | null> {
    if (!reserved || request.requestId !== reserved.requestId || state.session.kind !== 'authenticated') return null;
    const lease = reserved;
    reserved = null;
    if (now() >= lease.deadline) return fail({ kind: 'retry-expired', message: 'This request expired. Start a new request.' }, null);
    const parsed = agentRequestSchema.safeParse(request);
    if (!parsed.success) return fail({ kind: 'invalid-request', message: 'The request is incomplete or too large.' }, null);
    const body = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(body).byteLength > 64 * 1_024) return fail({ kind: 'invalid-request', message: 'The request is too large.' }, null);
    const history = [...parsed.data.history, { role: 'user' as const, content: parsed.data.message }].slice(-12);
    return run({ ...lease, body, binding: parsed.data.binding }, history);
  }

  async function retry(): Promise<AgentResponse | null> {
    const request = retryRequest;
    if (!request || state.session.kind !== 'authenticated') return null;
    if (now() >= request.deadline) return fail({ kind: 'retry-expired', message: 'Retry is no longer available. Start a new request.' }, null);
    return run(request);
  }

  function cancel(): void {
    retire();
    update({ ...state, session: state.session.kind === 'loading' ? { kind: 'unknown' } : state.session, turn: { kind: 'cancelled' } });
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    session, createRequestId, send, retry, cancel, reset,
  };
}
