import { createHash, timingSafeEqual } from "node:crypto";
import { runAgentTurn, type AgentOutcome } from "@drone/mission-planner/agent";
import {
  agentRequestIdSchema, agentRequestSchema, agentResponseSchema, previewMissionChange,
  type AgentActivity, type AgentFailure, type AgentProgressEvent, type AgentRequest, type MissionCandidate, type MissionChange,
} from "@drone/mission-planner/agent-contract";
import type { LanguageModel } from "ai";
import { describeMission, modelMissionChangeSchema } from "./mission-agent.ts";

const MAX_BODY_BYTES = 64 * 1024;
type ChatHandlerOptions = Readonly<{
  getAccessToken: () => string | undefined;
  getModel: () => LanguageModel | undefined;
  log?: (event: AgentLogEvent) => void;
}>;
export type AgentLogEvent = Readonly<{
  event: "agent-progress" | "agent-result";
  requestId: string;
  elapsedMs: number;
  provider: "openai" | "openrouter" | "other" | "unavailable";
  stage?: AgentProgressEvent["kind"];
  tool?: AgentActivity["tool"];
  outcome?: string;
  code?: AgentFailure["code"] | undefined;
  status?: number | undefined;
}>;

export function agentProvider(model: LanguageModel | undefined): AgentLogEvent["provider"] {
  if (!model) return "unavailable";
  if (typeof model !== "string" && model.provider.startsWith("openrouter.")) return "openrouter";
  if (typeof model !== "string" && model.provider.startsWith("openai.")) return "openai";
  return "other";
}

export function logAgentEvent(event: AgentLogEvent, log: (event: AgentLogEvent) => void = (value) => { console.error(JSON.stringify(value)); }): void {
  const requestId = agentRequestIdSchema.safeParse(event.requestId).success
    ? event.requestId : `ref:${createHash("sha256").update(event.requestId).digest("hex").slice(0, 16)}`;
  try { log({ ...event, requestId }); } catch { return; }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function matchesToken(header: string | null, expected: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export async function readBody(request: Request, limit = MAX_BODY_BYTES): Promise<
  | { kind: "read"; bytes: Uint8Array }
  | { kind: "too-large" }
  | { kind: "cancelled" }
  | { kind: "invalid" }
> {
  const reader = request.body?.getReader();
  if (!reader) return { kind: "read", bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  const cancelRead = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", cancelRead, { once: true });
  try {
    while (true) {
      if (request.signal.aborted) {
        cancelRead();
        return { kind: "cancelled" };
      }
      const part = await reader.read();
      if (request.signal.aborted) return { kind: "cancelled" };
      if (part.done) break;
      byteCount += part.value.byteLength;
      if (byteCount > limit) {
        cancelRead();
        return { kind: "too-large" };
      }
      chunks.push(part.value);
    }
  } catch {
    return request.signal.aborted ? { kind: "cancelled" } : { kind: "invalid" };
  } finally {
    request.signal.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "read", bytes };
}

export async function readJsonBody(request: Request, limit = MAX_BODY_BYTES): Promise<
  | { kind: "read"; value: unknown }
  | { kind: "too-large" }
  | { kind: "cancelled" }
  | { kind: "invalid" }
> {
  const body = await readBody(request, limit);
  if (body.kind !== "read") return body;
  try {
    return { kind: "read", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)) };
  } catch {
    return { kind: "invalid" };
  }
}

export function responseEnvelope(status: number, value: unknown, request: AgentRequest): Response {
  return json(status, agentResponseSchema.parse({
    requestId: request.requestId, binding: request.binding, outcome: value,
  }));
}

export function outcomeResponse(outcome: AgentOutcome<MissionChange, MissionCandidate>, request: AgentRequest): Response {
  switch (outcome.kind) {
    case "answered":
    case "needs-input":
      return responseEnvelope(200, outcome, request);
    case "proposed":
      return responseEnvelope(200, { kind: "proposed", change: outcome.change, activity: outcome.activity }, request);
    case "failed":
      return responseEnvelope(502, { ...outcome, message: "The model could not complete this request." }, request);
    case "cancelled":
      return responseEnvelope(499, outcome, request);
    case "deadline":
      return responseEnvelope(504, outcome, request);
    case "budget-exceeded":
      return responseEnvelope(429, outcome, request);
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export function createChatHandler({ getAccessToken, getModel, log }: ChatHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    let accessToken: string | undefined;
    try {
      accessToken = getAccessToken()?.trim();
    } catch {
      return json(503, { kind: "unavailable" });
    }
    if (!accessToken) return json(503, { kind: "unavailable" });
    if (!matchesToken(request.headers.get("authorization"), accessToken)) return json(401, { kind: "unauthorized" });
    if (request.method !== "POST") return json(405, { kind: "method-not-allowed" });

    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return json(415, { kind: "unsupported-media-type" });

    const body = await readJsonBody(request);
    if (body.kind === "too-large") return json(413, { kind: "payload-too-large" });
    if (body.kind === "cancelled") return json(499, { kind: "cancelled" });
    if (body.kind === "invalid") return json(400, { kind: "invalid-request" });

    const parsed = agentRequestSchema.safeParse(body.value);
    if (!parsed.success) return json(400, { kind: "invalid-request" });
    if (request.signal.aborted) return responseEnvelope(499, { kind: "cancelled", activity: [] }, parsed.data);

    const startedAt = Date.now();
    let model: LanguageModel | undefined;
    try {
      model = getModel();
    } catch {
      logAgentEvent({ event: "agent-result", requestId: parsed.data.requestId, elapsedMs: Date.now() - startedAt, provider: "unavailable", outcome: "failed", code: "internal-error", status: 502 }, log);
      return responseEnvelope(502, { kind: "failed", activity: [], diagnostic: { code: "internal-error" } }, parsed.data);
    }
    if (!model) {
      logAgentEvent({ event: "agent-result", requestId: parsed.data.requestId, elapsedMs: Date.now() - startedAt, provider: "unavailable", outcome: "unavailable", status: 503 }, log);
      return responseEnvelope(503, { kind: "unavailable", activity: [] }, parsed.data);
    }

    const outcome = await runAgentTurn(
      {
        message: parsed.data.message,
        history: parsed.data.history,
        snapshot: parsed.data.snapshot,
        binding: parsed.data.binding,
      },
      {
        model,
        changeSchema: modelMissionChangeSchema,
        describeSnapshot: async (snapshot) => describeMission(snapshot),
        previewChange: async (snapshot, change) => previewMissionChange(snapshot, change),
        signal: request.signal,
        onProgress: (event) => logAgentEvent({ event: "agent-progress", requestId: parsed.data.requestId, elapsedMs: event.elapsedMs, provider: agentProvider(model), stage: event.kind, ...(event.kind === "tool-start" || event.kind === "tool-end" || event.kind === "tool-rejected" ? { tool: event.tool } : {}) }, log),
      },
    );
    logAgentEvent({ event: "agent-result", requestId: parsed.data.requestId, elapsedMs: Date.now() - startedAt, provider: agentProvider(model), outcome: outcome.kind, ...(outcome.kind === "failed" ? { code: outcome.diagnostic?.code, status: outcome.diagnostic?.status } : {}) }, log);
    return outcomeResponse(outcome, parsed.data);
  };
}
