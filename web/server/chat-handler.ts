import { timingSafeEqual } from "node:crypto";
import { runAgentTurn, agentBindingSchema, type AgentOutcome } from "../../src/agent.ts";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  describeMission,
  isMissionInput,
  missionChangeSchema,
  previewMissionChange,
  type MissionCandidate,
  type MissionChange,
} from "./mission-agent.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_AGENT_INPUT_BYTES = 24_000;
const messageSchema = z.string().trim().min(1).max(4_000);
const historySchema = z.array(z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: messageSchema,
})).max(12).default([]);
const chatRequestSchema = z.strictObject({
  message: messageSchema,
  history: historySchema,
  snapshot: z.custom<import("@drone/mission-planner").MissionInput>(isMissionInput),
  binding: agentBindingSchema,
});
type ChatHandlerOptions = Readonly<{
  getAccessToken: () => string | undefined;
  getModel: () => LanguageModel | undefined;
}>;

function json(status: number, body: unknown): Response {
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

async function readBody(request: Request): Promise<
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
      if (byteCount > MAX_BODY_BYTES) {
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

function outcomeResponse(outcome: AgentOutcome<MissionChange, MissionCandidate>): Response {
  switch (outcome.kind) {
    case "answered":
    case "needs-input":
    case "proposed":
      return json(200, outcome);
    case "failed":
      return json(502, { ...outcome, message: "The model could not complete this request." });
    case "cancelled":
      return json(499, outcome);
    case "deadline":
      return json(504, outcome);
    case "budget-exceeded":
      return json(429, outcome);
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export function createChatHandler({ getAccessToken, getModel }: ChatHandlerOptions): (request: Request) => Promise<Response> {
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

    const body = await readBody(request);
    if (body.kind === "too-large") return json(413, { kind: "payload-too-large" });
    if (body.kind === "cancelled") return json(499, { kind: "cancelled" });
    if (body.kind === "invalid") return json(400, { kind: "invalid-request" });

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
    } catch {
      return json(400, { kind: "invalid-request" });
    }
    const parsed = chatRequestSchema.safeParse(value);
    if (!parsed.success) return json(400, { kind: "invalid-request" });
    if (Buffer.byteLength(JSON.stringify({
      message: parsed.data.message,
      history: parsed.data.history,
      binding: parsed.data.binding,
    })) > MAX_AGENT_INPUT_BYTES) return json(400, { kind: "invalid-request" });
    if (request.signal.aborted) return json(499, { kind: "cancelled" });

    let model: LanguageModel | undefined;
    try {
      model = getModel();
    } catch {
      return json(502, { kind: "failed", message: "The model could not complete this request." });
    }
    if (!model) return json(503, { kind: "unavailable" });

    const outcome = await runAgentTurn(
      {
        message: parsed.data.message,
        history: parsed.data.history,
        snapshot: parsed.data.snapshot,
        binding: parsed.data.binding,
      },
      {
        model,
        changeSchema: missionChangeSchema,
        describeSnapshot: async (snapshot) => describeMission(snapshot),
        previewChange: async (snapshot, change) => previewMissionChange(snapshot, change),
        signal: request.signal,
      },
    );
    return outcomeResponse(outcome);
  };
}
