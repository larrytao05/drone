import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { runAgentTurn } from "@drone/mission-planner/agent";
import {
  AGENT_RETRY_WINDOW_MS, AGENT_SCHEMA_VERSION, PLANNER_VERSION, agentEpochSchema,
  agentProgressRequestSchema, agentProgressResponseSchema, agentRequestSchema, agentSessionRequestSchema,
  canonicalAgentRequest, digestMissionInput, isCurrentAgentRequestId,
  previewMissionChange, sameAgentBinding, type AgentBinding, type AgentProgressEvent, type AgentRequest,
} from "@drone/mission-planner/agent-contract";
import type { LanguageModel } from "ai";
import { agentProvider, json, logAgentEvent, outcomeResponse, readJsonBody, responseEnvelope, type AgentLogEvent } from "./chat-handler.ts";
import { describeMission, modelMissionChangeSchema } from "./mission-agent.ts";

const COOKIE_NAME = "agent_session";
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_RECORDS = 16;
const MAX_ACTIVE = 2;
const LOGIN_LIMIT = 5;
const CHAT_LIMIT = 12;
const RATE_WINDOW_MS = 60_000;

type Environment = Readonly<{
  AGENT_LOGIN_PASSWORD?: string | undefined;
  AGENT_SESSION_SECRET?: string | undefined;
  AGENT_ALLOWED_ORIGIN?: string | undefined;
}>;
type Config = Readonly<{ password: string; secret: string; origin: string; secure: boolean }>;
type Options = Readonly<{
  getEnvironment: () => Environment;
  getModel: () => LanguageModel | undefined;
  now?: () => number;
  epoch?: string;
  log?: (event: AgentLogEvent) => void;
}>;
type RecordEntry = { fingerprint: string; binding: AgentBinding; startedAt: number; durationMs: number; events: AgentProgressEvent[]; expiresAt: number; completed: boolean; promise: Promise<Response> };

function parseConfig(environment: Environment): Config | null {
  const { AGENT_LOGIN_PASSWORD: password, AGENT_SESSION_SECRET: secret, AGENT_ALLOWED_ORIGIN: origin } = environment;
  if (!password || password.length < 12 || password.length > 256 || !secret || secret.length < 32 || !origin) return null;
  try {
    const url = new URL(origin);
    const secure = url.protocol === "https:";
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!secure && !loopback) || url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { password, secret, origin, secure };
  } catch {
    return null;
  }
}

function matchesSecret(supplied: string, expected: string): boolean {
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function cookieValue(request: Request): string | null {
  const matches = request.headers.get("cookie")?.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE_NAME}=`)) ?? [];
  return matches.length === 1 ? matches[0]?.slice(COOKIE_NAME.length + 1) ?? null : null;
}

function authenticated(request: Request, config: Config, epoch: string, now: number): boolean {
  const value = cookieValue(request);
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [cookieEpoch, expiryText, nonce, mac] = parts;
  if (cookieEpoch !== epoch || !expiryText || !/^\d{13}$/.test(expiryText) || !nonce || !/^[0-9a-f]{24}$/.test(nonce) || !mac || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const expiry = Number(expiryText);
  if (expiry <= now || expiry > now + SESSION_MS) return false;
  return matchesSecret(mac, sign(`${cookieEpoch}.${expiryText}.${nonce}`, config.secret));
}

function sessionCookie(config: Config, epoch: string, now: number): string {
  const unsigned = `${epoch}.${now + SESSION_MS}.${randomBytes(12).toString("hex")}`;
  return `${COOKIE_NAME}=${unsigned}.${sign(unsigned, config.secret)}; Path=/api/agent; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${config.secure ? "; Secure" : ""}`;
}

function clearCookie(config: Config): string {
  return `${COOKIE_NAME}=; Path=/api/agent; HttpOnly; SameSite=Strict; Max-Age=0${config.secure ? "; Secure" : ""}`;
}

function isJsonPost(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function parseBodyFailure(kind: "too-large" | "cancelled" | "invalid"): Response {
  if (kind === "too-large") return json(413, { kind: "payload-too-large" });
  if (kind === "cancelled") return json(499, { kind: "cancelled" });
  return json(400, { kind: "invalid-request" });
}

export function createBrowserAgentHandlers({ getEnvironment, getModel, now = Date.now, epoch = randomBytes(16).toString("hex"), log }: Options): {
  session: (request: Request) => Promise<Response>;
  chat: (request: Request) => Promise<Response>;
  progress: (request: Request) => Promise<Response>;
} {
  agentEpochSchema.parse(epoch);
  let currentEpoch = epoch;
  const records = new Map<string, RecordEntry>();
  let active = 0;
  const loginWindow = { start: 0, count: 0 };
  const chatWindow = { start: 0, count: 0 };

  function configuration(request: Request): Config | Response {
    let config: Config | null;
    try { config = parseConfig(getEnvironment()); } catch { config = null; }
    if (!config) return json(503, { kind: "unavailable" });
    if (request.headers.get("origin") !== config.origin) return json(403, { kind: "forbidden-origin" });
    return config;
  }

  function allowed(window: { start: number; count: number }, limit: number, at: number): boolean {
    if (at >= window.start + RATE_WINDOW_MS) { window.start = at; window.count = 0; }
    if (window.count >= limit) return false;
    window.count += 1;
    return true;
  }

  async function session(request: Request): Promise<Response> {
    const config = configuration(request);
    if (config instanceof Response) return config;
    if (request.method !== "POST") return json(405, { kind: "method-not-allowed" });
    if (!isJsonPost(request)) return json(415, { kind: "unsupported-media-type" });
    const body = await readJsonBody(request, 1_024);
    if (body.kind !== "read") return parseBodyFailure(body.kind);
    const parsed = agentSessionRequestSchema.safeParse(body.value);
    if (!parsed.success) return json(400, { kind: "invalid-request" });
    const value = parsed.data;
    const at = now();
    if (value.action === "status") {
      if (!authenticated(request, config, currentEpoch, at)) return json(200, { authenticated: false });
      return json(200, { authenticated: true, epoch: currentEpoch, serverNow: at, retryWindowMs: AGENT_RETRY_WINDOW_MS });
    }
    if (value.action === "logout") {
      if (!authenticated(request, config, currentEpoch, at)) return json(401, { kind: "unauthorized" });
      const response = json(200, { authenticated: false });
      response.headers.set("set-cookie", clearCookie(config));
      currentEpoch = randomBytes(16).toString("hex");
      return response;
    }
    if (!allowed(loginWindow, LOGIN_LIMIT, at)) return json(429, { kind: "rate-limited" });
    if (!matchesSecret(value.password, config.password)) return json(401, { kind: "unauthorized" });
    const response = json(200, { authenticated: true, epoch: currentEpoch, serverNow: at, retryWindowMs: AGENT_RETRY_WINDOW_MS });
    response.headers.set("set-cookie", sessionCookie(config, currentEpoch, at));
    return response;
  }

  function recordEvent(requestId: string, entry: RecordEntry, provider: AgentLogEvent["provider"], event: AgentProgressEvent): void {
    entry.events.push(event);
    if (entry.events.length > 16) entry.events.shift();
    logAgentEvent({ event: "agent-progress", requestId, elapsedMs: event.elapsedMs, provider, stage: event.kind, ...(event.kind === "tool-start" || event.kind === "tool-end" || event.kind === "tool-rejected" ? { tool: event.tool } : {}) }, log);
  }

  async function run(request: AgentRequest, entry: RecordEntry): Promise<Response> {
    let model: LanguageModel | undefined;
    try { model = getModel(); } catch {
      recordEvent(request.requestId, entry, "unavailable", { kind: "terminal", outcome: "failed", elapsedMs: Math.max(0, now() - entry.startedAt) });
      logAgentEvent({ event: "agent-result", requestId: request.requestId, elapsedMs: Math.max(0, now() - entry.startedAt), provider: "unavailable", outcome: "failed", code: "internal-error", status: 502 }, log);
      return responseEnvelope(502, { kind: "failed", activity: [], diagnostic: { code: "internal-error" } }, request);
    }
    if (!model) {
      recordEvent(request.requestId, entry, "unavailable", { kind: "terminal", outcome: "unavailable", elapsedMs: Math.max(0, now() - entry.startedAt) });
      logAgentEvent({ event: "agent-result", requestId: request.requestId, elapsedMs: Math.max(0, now() - entry.startedAt), provider: "unavailable", outcome: "unavailable", status: 503 }, log);
      return responseEnvelope(503, { kind: "unavailable", activity: [] }, request);
    }
    const provider = agentProvider(model);
    try {
      const outcome = await runAgentTurn({ message: request.message, history: request.history, snapshot: request.snapshot, binding: request.binding }, {
        model, changeSchema: modelMissionChangeSchema, describeSnapshot: async (snapshot) => describeMission(snapshot),
        previewChange: async (snapshot, change) => previewMissionChange(snapshot, change),
        onProgress: (event) => recordEvent(request.requestId, entry, provider, event),
      });
      logAgentEvent({ event: "agent-result", requestId: request.requestId, elapsedMs: Math.max(0, now() - entry.startedAt), provider, outcome: outcome.kind, ...(outcome.kind === "failed" ? { code: outcome.diagnostic?.code, status: outcome.diagnostic?.status } : {}) }, log);
      return outcomeResponse(outcome, request);
    } catch {
      recordEvent(request.requestId, entry, provider, { kind: "terminal", outcome: "failed", elapsedMs: Math.max(0, now() - entry.startedAt) });
      logAgentEvent({ event: "agent-result", requestId: request.requestId, elapsedMs: Math.max(0, now() - entry.startedAt), provider, outcome: "failed", code: "internal-error", status: 502 }, log);
      return responseEnvelope(502, { kind: "failed", activity: [], diagnostic: { code: "internal-error" } }, request);
    }
  }

  async function chat(request: Request): Promise<Response> {
    const config = configuration(request);
    if (config instanceof Response) return config;
    if (!authenticated(request, config, currentEpoch, now())) return json(401, { kind: "unauthorized" });
    if (request.method !== "POST") return json(405, { kind: "method-not-allowed" });
    if (!isJsonPost(request)) return json(415, { kind: "unsupported-media-type" });
    const body = await readJsonBody(request);
    if (body.kind !== "read") return parseBodyFailure(body.kind);
    const parsed = agentRequestSchema.safeParse(body.value);
    if (!parsed.success) return json(400, { kind: "invalid-request" });
    const agentRequest = parsed.data;
    if (agentRequest.binding.schemaVersion !== AGENT_SCHEMA_VERSION || agentRequest.binding.plannerVersion !== PLANNER_VERSION) return json(409, { kind: "incompatible-version" });
    if (agentRequest.binding.inputDigest !== await digestMissionInput(agentRequest.snapshot)) return json(409, { kind: "invalid-binding" });
    const at = now();
    if (request.signal.aborted) return json(499, { kind: "cancelled" });
    if (!isCurrentAgentRequestId(agentRequest.requestId, currentEpoch, at)) return json(409, { kind: "invalid-request-id" });
    const fingerprint = canonicalAgentRequest(agentRequest);
    const key = `single-user:${agentRequest.requestId}`;
    const existing = records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return json(409, { kind: "request-id-conflict" });
      return (await existing.promise).clone();
    }
    for (const [id, entry] of records) if (entry.completed && entry.expiresAt <= at) records.delete(id);
    if (records.size >= MAX_RECORDS) return json(503, { kind: "capacity-exceeded" });
    if (active >= MAX_ACTIVE) return json(429, { kind: "concurrency-limited" });
    if (!allowed(chatWindow, CHAT_LIMIT, at)) return json(429, { kind: "rate-limited" });
    active += 1;
    const entry: RecordEntry = {
      fingerprint, expiresAt: Number(agentRequest.requestId.split(".")[1]) + AGENT_RETRY_WINDOW_MS,
      binding: agentRequest.binding, startedAt: at, durationMs: 0, events: [],
      completed: false, promise: Promise.resolve().then(() => run(agentRequest, entry)),
    };
    records.set(key, entry);
    entry.promise = entry.promise.finally(() => { active -= 1; entry.durationMs = Math.max(0, now() - entry.startedAt); entry.completed = true; });
    return (await entry.promise).clone();
  }

  async function progress(request: Request): Promise<Response> {
    const config = configuration(request);
    if (config instanceof Response) return config;
    const at = now();
    if (!authenticated(request, config, currentEpoch, at)) return json(401, { kind: "unauthorized" });
    if (request.method !== "POST") return json(405, { kind: "method-not-allowed" });
    if (!isJsonPost(request)) return json(415, { kind: "unsupported-media-type" });
    const body = await readJsonBody(request, 1_024);
    if (body.kind !== "read") return parseBodyFailure(body.kind);
    const parsed = agentProgressRequestSchema.safeParse(body.value);
    if (!parsed.success) return json(400, { kind: "invalid-request" });
    if (!isCurrentAgentRequestId(parsed.data.requestId, currentEpoch, at)) return json(404, { kind: "not-found" });
    const entry = records.get(`single-user:${parsed.data.requestId}`);
    if (!entry || entry.expiresAt <= at) return json(404, { kind: "not-found" });
    if (!sameAgentBinding(parsed.data.binding, entry.binding)) return json(409, { kind: "invalid-binding" });
    return json(200, agentProgressResponseSchema.parse({
      requestId: parsed.data.requestId, binding: entry.binding,
      state: entry.completed ? "completed" : "running",
      elapsedMs: entry.completed ? entry.durationMs : Math.max(0, at - entry.startedAt), events: entry.events,
    }));
  }

  return { session, chat, progress };
}
