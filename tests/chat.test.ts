import { MockLanguageModelV3 } from "ai/test";
import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createChatHandler } from "../web/server/chat-handler.js";
import { getConfiguredModel } from "../web/server/model.js";
import { previewMissionChange, digestMissionInput, AGENT_SCHEMA_VERSION, PLANNER_VERSION, agentResponseSchema } from "../src/agent-contract.js";
import type { MissionInput } from "../src/index.js";

type ModelResponse = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
const call = (toolName: string, args: unknown = {}, toolCallId = "call-1") => ({ type: "tool-call", toolName, toolCallId, input: JSON.stringify(args) } satisfies ModelResponse["content"][number]);
const response = (content: ModelResponse["content"], finishReason: ModelResponse["finishReason"]["unified"] = "tool-calls"): ModelResponse => ({
  content, warnings: [], finishReason: { unified: finishReason, raw: finishReason },
  usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
});
const snapshot: MissionInput = {
  shot: { kind: "orbit", centre: { latitudeDeg: 41.1234567, longitudeDeg: -72.1234567 }, radiusM: 30, startBearingDeg: 0, direction: "clockwise", arc: { kind: "closed" } },
  heightAboveTakeoffM: 40, framing: { kind: "fixed", headingDeg: 0, gimbalPitchDeg: -20 },
};
const binding = { missionBranchId: "branch", revision: 2, inputDigest: await digestMissionInput(snapshot), schemaVersion: AGENT_SCHEMA_VERSION, plannerVersion: PLANNER_VERSION };
const payload = { requestId: "request-1", message: "Set orbit radius to 45 metres", snapshot, binding };
const request = (body: unknown, token = "private-token") => new Request("http://localhost/api/chat", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const handler = (model?: MockLanguageModelV3) => createChatHandler({ getAccessToken: () => "private-token", getModel: () => model });
const read = async (result: Response) => ({ status: result.status, body: await result.json(), cache: result.headers.get("cache-control") });

function previewId(prompt: unknown): string {
  const id = JSON.stringify(prompt).match(/"previewId":"([^"\\]+)"/)?.[1];
  if (!id) throw new Error("No preview ID");
  return id;
}

describe("private chat HTTP handler", () => {
  it("rejects unauthorised and malformed requests before constructing a model", async () => {
    const getModel = vi.fn(() => new MockLanguageModelV3({ doGenerate: response([{ type: "text", text: "ok" }], "stop") }));
    const handle = createChatHandler({ getAccessToken: () => "private-token", getModel });
    const unauthorised = await handle(request(payload, "wrong"));
    expect(await read(unauthorised)).toEqual({ status: 401, body: { kind: "unauthorized" }, cache: "no-store" });
    expect((await handle(new Request("http://localhost/api/chat", { method: "POST", headers: { authorization: "Bearer private-token", "content-type": "text/plain" }, body: "x" }))).status).toBe(415);
    expect((await handle(request({ ...payload, injectedTool: "fly" }))).status).toBe(400);
    expect((await handle(request({ ...payload, binding: { ...binding, revision: -1 } }))).status).toBe(400);
    expect((await handle(request({ ...payload, snapshot: { ...snapshot, shot: { ...snapshot.shot, radiusM: 20_000 } } }))).status).toBe(400);
    expect((await handle(new Request("http://localhost/api/chat", { method: "POST", headers: { authorization: "Bearer private-token", "content-type": "application/json" }, body: "{" }))).status).toBe(400);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("enforces actual body bytes and the agent envelope limit", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response([{ type: "text", text: "ok" }], "stop") });
    const oversized = { ...payload, padding: "x".repeat(65_536) };
    expect((await handler(model)(request(oversized))).status).toBe(413);
    const history = Array.from({ length: 12 }, () => ({ role: "user", content: "x".repeat(2_000) }));
    expect((await handler(model)(request({ ...payload, history }))).status).toBe(400);
    expect(model.doGenerateCalls).toHaveLength(0);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(32_768)); controller.enqueue(new Uint8Array(32_769)); controller.close(); },
    });
    const streamed = new Request("http://localhost/api/chat", {
      method: "POST", headers: { authorization: "Bearer private-token", "content-type": "application/json", "content-length": "1" }, body: chunks, duplex: "half",
    });
    expect((await handler(model)(streamed)).status).toBe(413);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("returns 503 for missing private configuration", async () => {
    const absentToken = createChatHandler({ getAccessToken: () => undefined, getModel: () => { throw new Error("must not run"); } });
    expect((await absentToken(request(payload))).status).toBe(503);
    expect((await handler()(request(payload))).status).toBe(503);
  });

  it("previews through the real planner and returns an immutable proposal", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async (options): Promise<ModelResponse> => {
      if (model.doGenerateCalls.length === 1) return response([call("get_mission_context")]);
      if (model.doGenerateCalls.length === 2) return response([call("preview_change", { kind: "set-orbit-radius", radiusM: 45 }, "call-2")]);
      return response([call("propose_change", { previewId: previewId(options.prompt) }, "call-3")]);
    } });
    const original = JSON.stringify(snapshot);
    const result = await read(await handler(model)(request(payload)));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ requestId: "request-1", binding, outcome: { kind: "proposed", change: { kind: "set-orbit-radius", radiusM: 45 } } });
    expect(agentResponseSchema.safeParse(result.body).success).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain("candidate");
    const expected = previewMissionChange(snapshot, { kind: "set-orbit-radius", radiusM: 45 });
    if (expected.kind !== "valid") throw new Error("Expected valid preview");
    expect(expected.candidate).toMatchObject({ input: {
      shot: { centre: { latitudeDeg: 41.1234567, longitudeDeg: -72.1234567 }, radiusM: 45, startBearingDeg: 0, direction: "clockwise", arc: { kind: "closed" } },
      heightAboveTakeoffM: 40, framing: { kind: "fixed", headingDeg: 0, gimbalPitchDeg: -20 },
    } });
    expect(expected.candidate.waypoints).toHaveLength(16);
    expect(snapshot.shot).toMatchObject({ radiusM: 30 });
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(JSON.stringify(model.doGenerateCalls)).not.toContain("41.1234567");
    expect(JSON.stringify(model.doGenerateCalls)).not.toContain("-72.1234567");
  });

  it("previews a route height edit and rejects an orbit radius edit on a route", async () => {
    const route: MissionInput = { shot: { kind: "route", anchors: [{ latitudeDeg: 40, longitudeDeg: -70 }, { latitudeDeg: 40.001, longitudeDeg: -70.001 }] }, heightAboveTakeoffM: 20, framing: { kind: "fixed", headingDeg: 45, gimbalPitchDeg: -10 } };
    const height = previewMissionChange(route, { kind: "set-height", heightAboveTakeoffM: 35 });
    expect(height).toMatchObject({ kind: "valid", candidate: { input: { heightAboveTakeoffM: 35, shot: { kind: "route" } } } });
    if (height.kind !== "valid") throw new Error("Expected height preview");
    expect(height.candidate.waypoints).toHaveLength(2);
    expect(route.heightAboveTakeoffM).toBe(20);
    expect(previewMissionChange(route, { kind: "set-orbit-radius", radiusM: 45 })).toMatchObject({ kind: "invalid", diagnostics: [{ code: "unsupported" }] });
  });

  it("cancels a pending provider turn", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<ModelResponse> => new Promise(() => {}) });
    const pending = handler(model)(new Request("http://localhost/api/chat", {
      method: "POST", headers: { authorization: "Bearer private-token", "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal,
    }));
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    controller.abort();
    expect((await pending).status).toBe(499);
  });

  it("returns a safe provider failure", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<ModelResponse> => { throw new Error("secret-provider-error"); } });
    const result = await read(await handler(model)(request(payload)));
    expect(result).toEqual({ status: 502, body: { requestId: "request-1", binding, outcome: { kind: "failed", activity: [], message: "The model could not complete this request." } }, cache: "no-store" });
  });

  it("retains completed tool activity after a provider failure", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<ModelResponse> => {
      if (model.doGenerateCalls.length === 1) return response([call("get_mission_context")]);
      throw new Error("secret-provider-error");
    } });
    const result = await read(await handler(model)(request(payload)));
    expect(result).toEqual({
      status: 502,
      body: { requestId: "request-1", binding, outcome: {
        kind: "failed",
        activity: [
          { tool: "get_mission_context", status: "started" },
          { tool: "get_mission_context", status: "succeeded" },
        ],
        message: "The model could not complete this request.",
      } },
      cache: "no-store",
    });
    expect(JSON.stringify(result)).not.toContain("secret-provider-error");
  });

  it("cancels a stalled body read without calling the model", async () => {
    const controller = new AbortController();
    const getModel = vi.fn(() => new MockLanguageModelV3({ doGenerate: response([{ type: "text", text: "ok" }], "stop") }));
    const handle = createChatHandler({ getAccessToken: () => "private-token", getModel });
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const pending = handle(new Request("http://localhost/api/chat", { method: "POST", headers: { authorization: "Bearer private-token", "content-type": "application/json" }, body, duplex: "half", signal: controller.signal }));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(getModel).not.toHaveBeenCalled();
  });
});

describe("OpenAI provider wiring", () => {
  it("sends configured model and store false to the Responses API", async () => {
    let captured: { url: string; authorization: string | null; body: Record<string, unknown> } | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      captured = { url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ error: { message: "fixture failure", type: "fixture_error" } }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const model = getConfiguredModel({ OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "fixture-model" }, fakeFetch);
    if (!model) throw new Error("Expected model");
    await expect(generateText({ model, prompt: "hello", maxRetries: 0 })).rejects.toThrow();
    expect(captured).toMatchObject({ url: "https://api.openai.com/v1/responses", authorization: "Bearer fixture-key", body: { model: "fixture-model", store: false } });
    expect(getConfiguredModel({}, fakeFetch)).toBeUndefined();
  });
});
