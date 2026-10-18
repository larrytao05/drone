import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgentTurn, type AgentDependencies } from "../src/agent.js";
import { planMission, type MissionInput } from "../src/index.js";
import { AGENT_SCHEMA_VERSION, PLANNER_VERSION, type AgentBinding } from "../src/agent-contract.js";

type Response = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
const call = (toolName: string, args: unknown = {}, toolCallId = "call-1") => ({ type: "tool-call", toolName, toolCallId, input: JSON.stringify(args) } satisfies Response["content"][number]);
const response = (content: Response["content"], finishReason: Response["finishReason"]["unified"] = "tool-calls"): Response => ({
  content, warnings: [], finishReason: { unified: finishReason, raw: finishReason },
  usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
});
const answer = (text = "Your orbit is 30 metres.") => response([{ type: "text", text }], "stop");
const binding = { missionBranchId: "branch", revision: 2, inputDigest: `sha256:${"0".repeat(64)}`, schemaVersion: AGENT_SCHEMA_VERSION, plannerVersion: PLANNER_VERSION } satisfies AgentBinding;
const snapshot: MissionInput = {
  shot: { kind: "orbit", centre: { latitudeDeg: 41.1234567, longitudeDeg: -72.1234567 }, radiusM: 30, startBearingDeg: 0, direction: "clockwise", arc: { kind: "closed" } },
  heightAboveTakeoffM: 40, framing: { kind: "fixed", headingDeg: 0, gimbalPitchDeg: -20 },
};
const changeSchema = z.strictObject({ radiusM: z.number().positive() });
type Change = z.infer<typeof changeSchema>;
const turn = { message: "Use 45 metres", snapshot, binding };
function fixture(model: MockLanguageModelV3) {
  const describeSnapshot = vi.fn(async () => ({ radiusM: 30 }));
  const previewChange = vi.fn(async (base: MissionInput, change: Change) => {
    if (base.shot.kind !== "orbit") throw new Error("Expected orbit");
    const candidate: MissionInput = { ...base, shot: { ...base.shot, radiusM: change.radiusM } };
    const result = planMission(candidate);
    if (result.kind === "invalid-input") return { kind: "invalid", diagnostics: { code: "invalid-plan" } } satisfies Awaited<ReturnType<AgentDependencies<MissionInput, Change, MissionInput>["previewChange"]>>;
    return { kind: "valid", candidate, summary: { radiusM: change.radiusM, waypointCount: result.waypoints.length } } satisfies Awaited<ReturnType<AgentDependencies<MissionInput, Change, MissionInput>["previewChange"]>>;
  });
  return { model, changeSchema, describeSnapshot, previewChange };
}
function previewId(prompt: unknown) {
  const match = JSON.stringify(prompt).match(/"previewId":"([^"\\]+)"/);
  const id = match?.[1];
  if (!id) throw new Error("No preview ID in tool result");
  return id;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("bounded mission agent", () => {
  it("clarifies a wider request, then previews and proposes the exact 45m candidate", async () => {
    const first = new MockLanguageModelV3({ doGenerate: response([call("ask_clarification", { question: "What radius should I use?" })]) });
    expect(await runAgentTurn({ ...turn, message: "Make this orbit wider" }, fixture(first))).toMatchObject({ kind: "needs-input", question: "What radius should I use?" });
    const model = new MockLanguageModelV3({ doGenerate: async (options): Promise<Response> => {
      if (model.doGenerateCalls.length === 1) return response([call("preview_change", { radiusM: 45 })]);
      return response([call("propose_change", { previewId: previewId(options.prompt) }, "call-2")]);
    } });
    const deps = fixture(model);
    const original = JSON.stringify(snapshot);
    const result = await runAgentTurn({ ...turn, history: [{ role: "user", content: "Make this orbit wider" }, { role: "assistant", content: "What radius should I use?" }] }, deps);
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") throw new Error("Expected proposal");
    const preview = await deps.previewChange.mock.results[0]?.value;
    if (preview?.kind !== "valid") throw new Error("Expected valid preview");
    expect(result.candidate).toBe(preview.candidate);
    expect(result.change).toBe(deps.previewChange.mock.calls[0]?.[1]);
    expect(result.binding).toEqual(binding);
    expect(result.change).toEqual({ radiusM: 45 });
    expect(result.candidate.shot).toMatchObject({ kind: "orbit", radiusM: 45 });
    expect(result.candidate.heightAboveTakeoffM).toBe(40);
    expect(result.candidate.framing).toEqual(snapshot.framing);
    expect(result.summary).toEqual({ radiusM: 45, waypointCount: 16 });
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls)).not.toContain("41.1234567");
    expect(JSON.stringify(model.doGenerateCalls)).not.toContain("heightAboveTakeoffM");
  });

  it("answers normally and can answer at the final allowed step", async () => {
    const model = new MockLanguageModelV3({ doGenerate: [response([call("get_mission_context")]), answer()] });
    expect(await runAgentTurn(turn, { ...fixture(model), limits: { modelCalls: 2 } })).toMatchObject({ kind: "answered", text: "Your orbit is 30 metres." });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it.each([
    [call("unknown")], [call("preview_change", { radiusM: "45" })],
    [call("get_mission_context", { extra: true })],
    [call("get_mission_context", {}, "same"), call("preview_change", { radiusM: 45 }, "same")],
    [call("ask_clarification", { question: "Radius?" }), call("get_mission_context", {}, "other")],
    [call("propose_change", { previewId: "missing" }), call("ask_clarification", { question: "Radius?" }, "other")],
    [{ ...call("get_mission_context"), providerExecuted: true }],
  ])("rejects an entire invalid or conflicting batch before application handlers", async (...calls) => {
    const model = new MockLanguageModelV3({ doGenerate: response(calls) });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, deps)).toMatchObject({ kind: "failed", activity: [] });
    expect(deps.describeSnapshot).not.toHaveBeenCalled();
    expect(deps.previewChange).not.toHaveBeenCalled();
  });

  it("rejects an over-budget parallel batch without partial execution", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response([call("get_mission_context"), call("preview_change", { radiusM: 45 }, "second")]) });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, { ...deps, limits: { toolCalls: 1 } })).toMatchObject({ kind: "budget-exceeded", activity: [] });
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(deps.describeSnapshot).not.toHaveBeenCalled();
  });

  it.each(["length", "content-filter", "error", "other"] satisfies Response["finishReason"]["unified"][])("rejects %s before any tool runs", async (reason) => {
    const model = new MockLanguageModelV3({ doGenerate: response([call("ask_clarification", { question: "Radius?" })], reason) });
    expect(await runAgentTurn(turn, fixture(model))).toMatchObject({ kind: "failed", activity: [] });
  });

  it("rejects empty text, unknown previews and invalid planner candidates", async () => {
    const empty = new MockLanguageModelV3({ doGenerate: answer("") });
    expect(await runAgentTurn(turn, fixture(empty))).toMatchObject({ kind: "failed" });
    const model = new MockLanguageModelV3({ doGenerate: [response([call("preview_change", { radiusM: 20_000 })]), response([call("propose_change", { previewId: "made-up" }, "second")])] });
    expect(await runAgentTurn(turn, fixture(model))).toMatchObject({ kind: "failed" });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("invalid-plan");
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).not.toContain("previewId");
  });

  it.each([{ modelCalls: 2 }, { toolCalls: 2 }])("bounds repeated calls with %j", async (limits) => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => response([call("get_mission_context", {}, `call-${model.doGenerateCalls.length}`)]) });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, { ...deps, limits })).toMatchObject({ kind: "budget-exceeded" });
    expect(deps.describeSnapshot).toHaveBeenCalledTimes(2);
    expect(model.doGenerateCalls.length).toBeLessThanOrEqual(3);
  });

  it("disables retry and sanitizes provider errors", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => { throw new APICallError({ message: "secret-provider-error", url: "https://private.test", requestBodyValues: {}, statusCode: 429, isRetryable: true }); } });
    const result = await runAgentTurn(turn, fixture(model));
    expect(result).toEqual({ kind: "failed", activity: [] });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("pre-cancelled turns make zero model calls", async () => {
    const model = new MockLanguageModelV3({ doGenerate: answer() });
    expect(await runAgentTurn(turn, { ...fixture(model), signal: AbortSignal.abort() })).toEqual({ kind: "cancelled", activity: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each(["provider", "tool"])("cancels a noncooperative %s and suppresses its late completion", async (stage) => {
    const pending = deferred<Response>();
    const entered = deferred<void>();
    const operation = deferred<unknown>();
    const controller = new AbortController();
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => {
      if (stage === "provider") { entered.resolve(); return pending.promise; }
      return response([call("get_mission_context")]);
    } });
    const deps = { ...fixture(model), signal: controller.signal, describeSnapshot: async (_snapshot: MissionInput, signal: AbortSignal) => { entered.resolve(); expect(signal.aborted).toBe(false); return operation.promise; } };
    const running = runAgentTurn(turn, deps);
    await entered.promise;
    controller.abort();
    const result = await running;
    expect(result.kind).toBe("cancelled");
    const before = JSON.stringify(result);
    pending.resolve(response([call("ask_clarification", { question: "Too late?" })]));
    operation.resolve({ radiusM: 30 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.stringify(result)).toBe(before);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it.each(["provider", "tool"])("deadlines a noncooperative %s", async (stage) => {
    const pending = new Promise<never>(() => {});
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => stage === "provider" ? pending : response([call("get_mission_context")]) });
    const result = await runAgentTurn(turn, { ...fixture(model), describeSnapshot: () => pending, limits: { deadlineMs: 20 } });
    expect(result.kind).toBe("deadline");
  });

  it("does not reuse preview IDs between runs", async () => {
    let priorId = "";
    const model = new MockLanguageModelV3({ doGenerate: async (options): Promise<Response> => {
      if (model.doGenerateCalls.length === 1) return response([call("preview_change", { radiusM: 45 })]);
      priorId = previewId(options.prompt);
      return response([call("propose_change", { previewId: priorId }, "second")]);
    } });
    expect((await runAgentTurn(turn, fixture(model))).kind).toBe("proposed");
    const next = new MockLanguageModelV3({ doGenerate: response([call("propose_change", { previewId: priorId })]) });
    expect((await runAgentTurn(turn, fixture(next))).kind).toBe("failed");
  });

  it("bounds input and rejects unsafe or oversized model data without exposing errors", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response([call("get_mission_context")]) });
    expect((await runAgentTurn({ ...turn, message: "x".repeat(4_001) }, fixture(model))).kind).toBe("failed");
    expect((await runAgentTurn(turn, { ...fixture(model), limits: { modelCalls: 5 } })).kind).toBe("failed");
    expect(model.doGenerateCalls).toHaveLength(0);
    const sparse: unknown[] = [];
    sparse.length = 2;
    for (const unsafe of [
      { value: "x".repeat(8_001) }, "x".repeat(8_001), { ["k".repeat(8_001)]: "value" }, sparse,
      new Error("private error"), new Proxy({}, {}), { get privateValue() { throw new Error("secret getter"); } },
    ]) {
      const next = new MockLanguageModelV3({ doGenerate: response([call("get_mission_context")]) });
      const result = await runAgentTurn(turn, { ...fixture(next), describeSnapshot: async () => unsafe });
      expect(result.kind).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("private");
      expect(next.doGenerateCalls).toHaveLength(1);
    }
  });
});
