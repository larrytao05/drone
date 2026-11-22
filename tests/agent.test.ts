import { APICallError, ToolChoiceViolationError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgentTurn, type AgentDependencies } from "../src/agent.js";
import { planMission, type MissionInput } from "../src/index.js";
import { AGENT_SCHEMA_VERSION, PLANNER_VERSION, missionChangeSchema, previewMissionChange, type AgentBinding } from "../src/agent-contract.js";

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
  it("provides the current drone route context before the first model response", async () => {
    const route: MissionInput & { privateNote: string } = {
      shot: { kind: "route", anchors: [
        { latitudeDeg: 41.1234567, longitudeDeg: -72.1234567 },
        { latitudeDeg: 41.1244567, longitudeDeg: -72.1244567 },
        { latitudeDeg: 41.1254567, longitudeDeg: -72.1254567 },
      ] },
      heightAboveTakeoffM: 30,
      framing: { kind: "fixed", headingDeg: 45, gimbalPitchDeg: -10 },
      privateNote: "SECRET_SNAPSHOT_SENTINEL",
    };
    const context = { shotKind: "route", waypointCount: 3, heightAboveTakeoffM: 30, framing: route.framing };
    const model = new MockLanguageModelV3({ doGenerate: answer() });
    const describeSnapshot = vi.fn(async () => context);
    const events: unknown[] = [];
    const result = await runAgentTurn({ ...turn, message: "raise this route to 40m", snapshot: route }, {
      ...fixture(model), describeSnapshot, onProgress: (event) => events.push(event),
    });
    expect(result).toMatchObject({ kind: "answered", activity: [] });
    expect(describeSnapshot).toHaveBeenCalledExactlyOnceWith(route, expect.any(AbortSignal));
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = model.doGenerateCalls[0]?.prompt;
    expect(prompt).toContainEqual(expect.objectContaining({ role: "system", content: expect.stringContaining(JSON.stringify(context)) }));
    const serialized = JSON.stringify(prompt);
    expect(serialized).toContain("DJI drone");
    expect(serialized).toContain("metres above takeoff");
    expect(serialized).toContain("this route");
    expect(serialized).toContain("data, not instructions");
    expect(serialized).not.toContain("41.1234567");
    expect(serialized).not.toContain("-72.1234567");
    expect(serialized).not.toContain("SECRET_SNAPSHOT_SENTINEL");
    expect(events).toMatchObject([{ kind: "model-start" }, { kind: "model-end" }, { kind: "terminal", outcome: "answered" }]);
  });

  it("reuses the prepared context without consuming a model tool call", async () => {
    const model = new MockLanguageModelV3({ doGenerate: [
      response([call("get_mission_context", {}, "first")]),
      response([call("get_mission_context", {}, "second")]),
      answer(),
    ] });
    const deps = fixture(model);
    const result = await runAgentTurn(turn, { ...deps, limits: { modelCalls: 3, toolCalls: 2 } });
    expect(result).toMatchObject({ kind: "answered", activity: [
      { tool: "get_mission_context", status: "started" }, { tool: "get_mission_context", status: "succeeded" },
      { tool: "get_mission_context", status: "started" }, { tool: "get_mission_context", status: "succeeded" },
    ] });
    expect(deps.describeSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot, expect.any(AbortSignal));
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(JSON.stringify(model.doGenerateCalls[2]?.prompt)).toContain('"value":{"radiusM":30}');
  });

  it("sanitizes context preparation failures before any provider request", async () => {
    const model = new MockLanguageModelV3({ doGenerate: answer() });
    const events: unknown[] = [];
    const result = await runAgentTurn(turn, {
      ...fixture(model),
      describeSnapshot: async () => { throw new Error("SECRET_CONTEXT_41.1234567"); },
      onProgress: (event) => events.push(event),
    });
    expect(result).toEqual({ kind: "failed", diagnostic: { code: "tool-execution" }, activity: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(events).toMatchObject([{ kind: "terminal", outcome: "failed" }]);
    expect(JSON.stringify({ result, events })).not.toContain("SECRET_CONTEXT");
    expect(JSON.stringify({ result, events })).not.toContain("41.1234567");
  });

  it("suppresses a context loader's late success after its deadline", async () => {
    const operation = deferred<unknown>();
    const model = new MockLanguageModelV3({ doGenerate: answer() });
    const events: unknown[] = [];
    const result = await runAgentTurn(turn, {
      ...fixture(model), describeSnapshot: () => operation.promise,
      limits: { deadlineMs: 20 }, onProgress: (event) => events.push(event),
    });
    expect(result).toEqual({ kind: "deadline", activity: [] });
    const before = JSON.stringify({ result, events });
    operation.resolve({ radiusM: 30 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(JSON.stringify({ result, events })).toBe(before);
  });

  it.each([
    { kind: "set-height" },
    { kind: "set-height", heightAboveTakeoffM: "40" },
  ])("corrects one schema-invalid route height preview before proposing 40m with %j", async (invalidChange) => {
    const route: MissionInput = {
      shot: { kind: "route", anchors: [
        { latitudeDeg: 40, longitudeDeg: -70 },
        { latitudeDeg: 40.001, longitudeDeg: -70.001 },
        { latitudeDeg: 40.002, longitudeDeg: -70.002 },
      ] },
      heightAboveTakeoffM: 30,
      framing: { kind: "fixed", headingDeg: 45, gimbalPitchDeg: -10 },
    };
    const model = new MockLanguageModelV3({ doGenerate: async (options): Promise<Response> => {
      if (model.doGenerateCalls.length === 1) return response([call("get_mission_context", {}, "context")]);
      if (model.doGenerateCalls.length === 2) return response([call("preview_change", invalidChange, "invalid")]);
      if (model.doGenerateCalls.length === 3) return response([call("preview_change", { kind: "set-height", heightAboveTakeoffM: 40 }, "valid")]);
      return response([call("propose_change", { previewId: previewId(options.prompt) }, "proposal")]);
    } });
    const previewChange = vi.fn(async (base: MissionInput, change: z.infer<typeof missionChangeSchema>) => previewMissionChange(base, change));
    const events: unknown[] = [];
    const original = JSON.stringify(route);
    const result = await runAgentTurn({ ...turn, message: "raise this route to 40m", snapshot: route }, {
      model, changeSchema: missionChangeSchema, previewChange,
      describeSnapshot: async () => ({ shotKind: "route", heightAboveTakeoffM: 30, waypointCount: 3 }),
      onProgress: (event) => events.push(event),
    });
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") throw new Error("Expected proposal");
    expect(result.change).toEqual({ kind: "set-height", heightAboveTakeoffM: 40 });
    expect(result.candidate.input.heightAboveTakeoffM).toBe(40);
    expect(result.candidate.waypoints).toHaveLength(3);
    expect(result.candidate.waypoints.every((waypoint) => waypoint.heightAboveTakeoffM === 40)).toBe(true);
    expect(result.candidate.input.shot).toEqual(route.shot);
    expect(previewChange).toHaveBeenCalledExactlyOnceWith(route, { kind: "set-height", heightAboveTakeoffM: 40 }, expect.any(AbortSignal));
    expect(model.doGenerateCalls).toHaveLength(4);
    expect(model.doGenerateCalls.map((options) => options.toolChoice)).toEqual([
      { type: "auto" }, { type: "auto" }, { type: "auto" }, { type: "required" },
    ]);
    expect(JSON.stringify(model.doGenerateCalls[2]?.prompt)).toContain("AI_InvalidToolInputError");
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool-rejected", tool: "preview_change" }));
    expect(result.activity).toContainEqual({ tool: "preview_change", status: "rejected" });
    expect(JSON.stringify(route)).toBe(original);
  });

  it("rejects prose after a valid preview without exposing the generated text", async () => {
    const sentinel = "SECRET_GENERATED_PREVIEW_SENTINEL_41.1234567";
    const model = new MockLanguageModelV3({ doGenerate: [
      response([call("preview_change", { radiusM: 45 })]), answer(sentinel),
    ] });
    const events: unknown[] = [];
    const result = await runAgentTurn(turn, { ...fixture(model), onProgress: (event) => events.push(event) });
    expect(result).toMatchObject({ kind: "failed", diagnostic: { code: "invalid-tool-call" } });
    expect(result.activity).toEqual([{ tool: "preview_change", status: "started" }, { tool: "preview_change", status: "succeeded" }]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify({ result, events })).not.toContain(sentinel);
    expect(events.at(-1)).toMatchObject({ kind: "terminal", outcome: "failed" });
  });

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

  it("can inspect context and explicitly propose the first of multiple valid previews", async () => {
    let firstPreviewId = "";
    const model = new MockLanguageModelV3({ doGenerate: async (options): Promise<Response> => {
      if (model.doGenerateCalls.length === 1) return response([call("preview_change", { radiusM: 45 }, "first")]);
      if (model.doGenerateCalls.length === 2) {
        firstPreviewId = previewId(options.prompt);
        return response([call("preview_change", { radiusM: 60 }, "second")]);
      }
      if (model.doGenerateCalls.length === 3) return response([call("get_mission_context", {}, "context")]);
      return response([call("propose_change", { previewId: firstPreviewId }, "proposal")]);
    } });
    const deps = fixture(model);
    const result = await runAgentTurn(turn, deps);
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") throw new Error("Expected proposal");
    const firstPreview = await deps.previewChange.mock.results[0]?.value;
    if (firstPreview?.kind !== "valid") throw new Error("Expected valid preview");
    expect(result.candidate).toBe(firstPreview.candidate);
    expect(result.change).toEqual({ radiusM: 45 });
    expect(deps.previewChange).toHaveBeenCalledTimes(2);
    expect(deps.describeSnapshot).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls.map((options) => options.toolChoice)).toEqual([
      { type: "auto" }, { type: "required" }, { type: "required" }, { type: "required" },
    ]);
  });

  it("can ask clarification after a valid preview", async () => {
    const model = new MockLanguageModelV3({ doGenerate: [
      response([call("preview_change", { radiusM: 45 })]),
      response([call("ask_clarification", { question: "Should I use this radius or compare another?" }, "question")]),
    ] });
    const result = await runAgentTurn(turn, fixture(model));
    expect(result).toMatchObject({ kind: "needs-input", question: "Should I use this radius or compare another?" });
    expect(model.doGenerateCalls[1]?.toolChoice).toEqual({ type: "required" });
  });

  it("allows an information answer after a planner-invalid preview", async () => {
    const model = new MockLanguageModelV3({ doGenerate: [
      response([call("preview_change", { radiusM: 20_000 })]), answer("That radius exceeds the planner limits."),
    ] });
    expect(await runAgentTurn(turn, fixture(model))).toMatchObject({ kind: "answered", text: "That radius exceeds the planner limits." });
    expect(model.doGenerateCalls.map((options) => options.toolChoice)).toEqual([{ type: "auto" }, { type: "auto" }]);
  });

  it.each([{ modelCalls: 2 }, { toolCalls: 2 }])("bounds unfinished valid previews with %j", async (limits) => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => response([
      call("preview_change", { radiusM: 45 }, `preview-${model.doGenerateCalls.length}`),
    ]) });
    expect(await runAgentTurn(turn, { ...fixture(model), limits })).toMatchObject({ kind: "budget-exceeded" });
    expect(model.doGenerateCalls.length).toBeLessThanOrEqual(3);
    expect(model.doGenerateCalls.slice(1).every((options) => options.toolChoice?.type === "required")).toBe(true);
  });

  it("sanitizes tool choice violation messages and content", async () => {
    const sentinel = "SECRET_TOOL_CHOICE_SENTINEL_41.1234567";
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => {
      throw new ToolChoiceViolationError({
        toolChoice: { type: "required" }, finishReason: "stop", provider: sentinel, modelId: sentinel,
        content: [{ type: "text", text: sentinel }], message: sentinel,
      });
    } });
    const events: unknown[] = [];
    const result = await runAgentTurn(turn, { ...fixture(model), onProgress: (event) => events.push(event) });
    expect(result).toEqual({ kind: "failed", diagnostic: { code: "invalid-tool-call" }, activity: [] });
    expect(JSON.stringify({ result, events })).not.toContain(sentinel);
  });

  it("answers normally and can answer at the final allowed step", async () => {
    const model = new MockLanguageModelV3({ doGenerate: [response([call("get_mission_context")]), answer()] });
    expect(await runAgentTurn(turn, { ...fixture(model), limits: { modelCalls: 2 } })).toMatchObject({ kind: "answered", text: "Your orbit is 30 metres." });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(model.doGenerateCalls.map((options) => options.toolChoice)).toEqual([{ type: "auto" }, { type: "auto" }]);
  });

  it.each([
    [call("unknown")], [call("preview_change", { radiusM: "45" }), call("get_mission_context", {}, "other")],
    [call("get_mission_context", { extra: true })],
    [{ ...call("preview_change"), input: "{broken-json" }],
    [call("preview_change", [])], [call("preview_change", null)], [call("preview_change", "45")],
    [call("get_mission_context", {}, "same"), call("preview_change", { radiusM: 45 }, "same")],
    [call("ask_clarification", { question: "Radius?" }), call("get_mission_context", {}, "other")],
    [call("propose_change", { previewId: "missing" }), call("ask_clarification", { question: "Radius?" }, "other")],
    [{ ...call("get_mission_context"), providerExecuted: true }],
    [{ ...call("preview_change", { radiusM: "45" }), providerExecuted: true }],
  ])("rejects an entire invalid or conflicting batch before application handlers", async (...calls) => {
    const model = new MockLanguageModelV3({ doGenerate: response(calls) });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, deps)).toMatchObject({ kind: "failed", activity: [] });
    expect(deps.describeSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("rejects a second invalid preview and keeps its validation feedback private", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => response([
      call("preview_change", { radiusM: "SECRET_SENTINEL_40.123456" }, `invalid-${model.doGenerateCalls.length}`),
    ]) });
    const deps = fixture(model);
    const events: unknown[] = [];
    const result = await runAgentTurn(turn, { ...deps, onProgress: (event) => events.push(event) });
    expect(result).toMatchObject({ kind: "failed", diagnostic: { code: "invalid-tool-call" }, activity: [{ tool: "preview_change", status: "rejected" }] });
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("SECRET_SENTINEL_40.123456");
    expect(JSON.stringify({ result, events })).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify({ result, events })).not.toContain("40.123456");
    expect(JSON.stringify({ result, events })).not.toContain("InvalidToolInputError");
  });

  it("allows a normal answer after rejected preview feedback", async () => {
    const model = new MockLanguageModelV3({ doGenerate: [response([call("preview_change", { radiusM: "45" })]), answer("I could not preview that change.")] });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, deps)).toMatchObject({ kind: "answered", text: "I could not preview that change.", activity: [{ tool: "preview_change", status: "rejected" }] });
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it.each([false, true])("reserves the rejected call ID before a later %s invalid call", async (invalid) => {
    const model = new MockLanguageModelV3({ doGenerate: [
      response([call("preview_change", { radiusM: "45" }, "reserved")]),
      response([call("preview_change", { radiusM: invalid ? "45" : 45 }, "reserved")]),
    ] });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, deps)).toMatchObject({ kind: "failed", diagnostic: { code: "invalid-tool-call" }, activity: [{ tool: "preview_change", status: "rejected" }] });
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it.each([{ modelCalls: 1 }, { toolCalls: 1 }])("does not correct a preview without remaining budget %j", async (limits) => {
    const model = new MockLanguageModelV3({ doGenerate: response([call("preview_change", { radiusM: "45" })]) });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, { ...deps, limits })).toMatchObject({ kind: "budget-exceeded", activity: [{ tool: "preview_change", status: "rejected" }] });
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("charges the rejected attempt against the remaining tool budget", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async (options): Promise<Response> => {
      if (model.doGenerateCalls.length === 1) return response([call("preview_change", { radiusM: "45" }, "invalid")]);
      if (model.doGenerateCalls.length === 2) return response([call("preview_change", { radiusM: 45 }, "valid")]);
      return response([call("propose_change", { previewId: previewId(options.prompt) }, "proposal")]);
    } });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, { ...deps, limits: { toolCalls: 2 } })).toMatchObject({ kind: "budget-exceeded" });
    expect(deps.previewChange).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it.each(["cancelled", "deadline"])("preserves %s while waiting for a preview correction", async (kind) => {
    const pending = deferred<Response>();
    const entered = deferred<void>();
    const controller = new AbortController();
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => {
      if (model.doGenerateCalls.length === 1) return response([call("preview_change", { radiusM: "45" }, "invalid")]);
      entered.resolve();
      return pending.promise;
    } });
    const deps = fixture(model);
    const running = runAgentTurn(turn, { ...deps, signal: controller.signal, limits: { deadlineMs: kind === "deadline" ? 20 : 30_000 } });
    await entered.promise;
    if (kind === "cancelled") controller.abort();
    const result = await running;
    expect(result).toMatchObject({ kind, activity: [{ tool: "preview_change", status: "rejected" }] });
    const before = JSON.stringify(result);
    pending.resolve(response([call("preview_change", { radiusM: 45 }, "late")]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toBe(before);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("rejects an over-budget parallel batch without partial execution", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response([call("get_mission_context"), call("preview_change", { radiusM: 45 }, "second")]) });
    const deps = fixture(model);
    expect(await runAgentTurn(turn, { ...deps, limits: { toolCalls: 1 } })).toMatchObject({ kind: "budget-exceeded", activity: [] });
    expect(deps.previewChange).not.toHaveBeenCalled();
    expect(deps.describeSnapshot).toHaveBeenCalledTimes(1);
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
    expect(deps.describeSnapshot).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls.length).toBeLessThanOrEqual(3);
  });

  it("disables retry and sanitizes provider errors", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => { throw new APICallError({ message: "secret-provider-error", url: "https://private.test", requestBodyValues: {}, statusCode: 429, isRetryable: true }); } });
    const result = await runAgentTurn(turn, fixture(model));
    expect(result).toEqual({ kind: "failed", activity: [], diagnostic: { code: "provider-rate-limit", status: 429 } });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it.each([
    [401, "provider-auth"], [403, "provider-auth"], [404, "model-unavailable"],
    [429, "provider-rate-limit"], [502, "provider-unavailable"], [400, "provider-error"],
  ] as const)("classifies provider status %i without exposing its body", async (status, code) => {
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => {
      throw new APICallError({ message: "SECRET_SENTINEL_40.123456", url: "https://private.test", requestBodyValues: { secret: "SECRET_SENTINEL" }, statusCode: status });
    } });
    const events: unknown[] = [];
    const result = await runAgentTurn(turn, { ...fixture(model), onProgress: (event) => events.push(event) });
    expect(result).toMatchObject({ kind: "failed", diagnostic: { code, status } });
    expect(events).toMatchObject([{ kind: "model-start" }, { kind: "terminal", outcome: "failed" }]);
    expect(JSON.stringify({ result, events })).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify({ result, events })).not.toContain("40.123456");
  });

  it("reports safe tool stages and ignores observer failures", async () => {
    const model = new MockLanguageModelV3({ doGenerate: [response([call("get_mission_context")]), answer()] });
    const events: unknown[] = [];
    const result = await runAgentTurn(turn, { ...fixture(model), onProgress: (event) => { events.push(event); throw new Error("observer secret"); } });
    expect(result.kind).toBe("answered");
    expect(events).toMatchObject([
      { kind: "model-start" }, { kind: "model-end" },
      { kind: "tool-start", tool: "get_mission_context" }, { kind: "tool-end", tool: "get_mission_context" },
      { kind: "model-start" }, { kind: "model-end" }, { kind: "terminal", outcome: "answered" },
    ]);
    expect(JSON.stringify(events)).not.toContain("observer secret");
  });

  it("distinguishes invalid tool calls and truncated model output without retaining tool names", async () => {
    const invalid = await runAgentTurn(turn, fixture(new MockLanguageModelV3({ doGenerate: response([call("SECRET_UNKNOWN_TOOL")]) })));
    expect(invalid).toMatchObject({ kind: "failed", diagnostic: { code: "invalid-tool-call" } });
    expect(JSON.stringify(invalid)).not.toContain("SECRET_UNKNOWN_TOOL");
    const truncated = await runAgentTurn(turn, fixture(new MockLanguageModelV3({ doGenerate: response([], "length") })));
    expect(truncated).toMatchObject({ kind: "failed", diagnostic: { code: "output-limit" } });
  });

  it("pre-cancelled turns make zero model calls", async () => {
    const model = new MockLanguageModelV3({ doGenerate: answer() });
    expect(await runAgentTurn(turn, { ...fixture(model), signal: AbortSignal.abort() })).toEqual({ kind: "cancelled", activity: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("cancels queued context preparation before the loader or model runs", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({ doGenerate: answer() });
    const deps = fixture(model);
    const running = runAgentTurn(turn, { ...deps, signal: controller.signal });
    controller.abort();
    expect(await running).toEqual({ kind: "cancelled", activity: [] });
    expect(deps.describeSnapshot).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each(["provider", "context"])("cancels a noncooperative %s and suppresses its late completion", async (stage) => {
    const pending = deferred<Response>();
    const entered = deferred<void>();
    const operation = deferred<unknown>();
    const controller = new AbortController();
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => {
      if (stage === "provider") { entered.resolve(); return pending.promise; }
      return response([call("get_mission_context")]);
    } });
    const deps = { ...fixture(model), signal: controller.signal, describeSnapshot: async (_snapshot: MissionInput, signal: AbortSignal) => {
      if (stage === "provider") return { radiusM: 30 };
      entered.resolve();
      expect(signal.aborted).toBe(false);
      return operation.promise;
    } };
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
    expect(model.doGenerateCalls).toHaveLength(stage === "provider" ? 1 : 0);
  });

  it.each(["provider", "context"])("deadlines a noncooperative %s", async (stage) => {
    const pending = new Promise<never>(() => {});
    const model = new MockLanguageModelV3({ doGenerate: async (): Promise<Response> => stage === "provider" ? pending : response([call("get_mission_context")]) });
    const result = await runAgentTurn(turn, { ...fixture(model), describeSnapshot: () => stage === "provider" ? Promise.resolve({ radiusM: 30 }) : pending, limits: { deadlineMs: 20 } });
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
      expect(result).toEqual({ kind: "failed", activity: [], diagnostic: { code: "tool-execution" } });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(next.doGenerateCalls).toHaveLength(0);
    }
  });
});
