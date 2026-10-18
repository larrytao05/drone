import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { agentBindingSchema, agentHistorySchema, agentMessageSchema, type AgentActivity, type AgentBinding } from "./agent-contract.js";

type ModelData = z.infer<ReturnType<typeof z.json>>;

const inputSchema = z.strictObject({
  message: agentMessageSchema,
  history: agentHistorySchema,
  binding: agentBindingSchema,
});
const limitsSchema = z.strictObject({
  modelCalls: z.number().int().min(1).max(4).default(4),
  toolCalls: z.number().int().min(1).max(6).default(6),
  deadlineMs: z.number().int().min(1).max(30_000).default(30_000),
});
type ToolName = "get_mission_context" | "preview_change" | "propose_change" | "ask_clarification";
export type AgentPreview<Candidate> =
  | { kind: "valid"; candidate: Candidate; summary: unknown }
  | { kind: "invalid"; diagnostics: unknown };
type Failure = { kind: "failed" | "cancelled" | "deadline" | "budget-exceeded" };
type Choice<Change, Candidate> =
  | { kind: "proposed"; binding: AgentBinding; change: Change; candidate: Candidate; summary: ModelData }
  | { kind: "needs-input"; question: string };
export type AgentOutcome<Change, Candidate> = (Choice<Change, Candidate> | Failure | { kind: "answered"; text: string }) & {
  activity: readonly AgentActivity[];
};
export type AgentDependencies<Snapshot, Change, Candidate> = {
  model: LanguageModel;
  changeSchema: z.ZodType<Change>;
  // Callers redact locations and private data from context, summaries and diagnostics.
  describeSnapshot: (snapshot: Snapshot, signal: AbortSignal) => Promise<unknown>;
  previewChange: (snapshot: Snapshot, change: Change, signal: AbortSignal) => Promise<AgentPreview<Candidate>>;
  signal?: AbortSignal;
  limits?: Partial<z.infer<typeof limitsSchema>>;
};

function modelData(value: unknown): ModelData {
  let nodes = 0;
  let bytes = 0;
  function copy(item: unknown, depth: number): ModelData {
    if (++nodes > 2_000 || depth > 12) throw new Error("Invalid model data");
    if (typeof item === "string") {
      if (item.length > 8_000) throw new Error("Model data too large");
      bytes += Buffer.byteLength(item);
      if (bytes > 8_000) throw new Error("Model data too large");
      return item;
    }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || types.isProxy(item)) throw new Error("Invalid model data");
    if (Array.isArray(item) && item.length > 2_000) throw new Error("Model data too large");
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error("Invalid model data");
    const result: Record<string, ModelData> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("Invalid model data");
      if (key.length > 8_000) throw new Error("Model data too large");
      bytes += Buffer.byteLength(key);
      if (bytes > 8_000) throw new Error("Model data too large");
      const child: unknown = descriptor.value;
      result[key] = copy(child, depth + 1);
    }
    if (!Array.isArray(item)) return result;
    return Array.from({ length: item.length }, (_, i) => {
      const child = result[String(i)];
      if (child === undefined) throw new Error("Invalid model data");
      return child;
    });
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 8_000) throw new Error("Model data too large");
  return result;
}

export async function runAgentTurn<Snapshot, Change, Candidate>(
  input: { message: string; snapshot: Snapshot; binding: AgentBinding; history?: readonly { role: "user" | "assistant"; content: string }[] },
  deps: AgentDependencies<Snapshot, Change, Candidate>,
): Promise<AgentOutcome<Change, Candidate>> {
  const activity: AgentActivity[] = [];
  if (deps.signal?.aborted) return { kind: "cancelled", activity };
  const parsed = inputSchema.safeParse({ message: input.message, binding: input.binding, history: input.history });
  const limits = limitsSchema.safeParse(deps.limits ?? {});
  if (!parsed.success || !limits.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 24_000) return { kind: "failed", activity };
  const controller = new AbortController();
  const run: { state: { kind: "running" } | Failure | Choice<Change, Candidate> } = { state: { kind: "running" } };
  let modelCalls = 0;
  let toolCalls = 0;
  const callIds = new Set<string>();
  const admitted = new Set<string>();
  const previews = new Map<string, { change: Change; candidate: Candidate; summary: ModelData }>();
  const fail = (kind: Failure["kind"]) => {
    if (controller.signal.aborted) return;
    run.state = { kind };
    controller.abort();
  };
  const cancel = () => fail("cancelled");
  deps.signal?.addEventListener("abort", cancel, { once: true });
  if (deps.signal?.aborted) cancel();
  const timer = setTimeout(() => fail("deadline"), limits.data.deadlineMs);
  const execute = async (name: ToolName, id: string, action: () => Promise<ModelData>): Promise<ModelData> => {
    if (controller.signal.aborted || run.state.kind !== "running" || !admitted.delete(id)) return { error: "run-stopped" };
    activity.push({ tool: name, status: "started" });
    try {
      const result = await action();
      if (controller.signal.aborted) return { error: "run-stopped" };
      activity.push({ tool: name, status: "succeeded" });
      return result;
    } catch {
      if (!controller.signal.aborted) activity.push({ tool: name, status: "rejected" });
      fail("failed");
      return { error: "operation-failed" };
    }
  };
  const tools = {
    get_mission_context: tool({
      description: "Read redacted mission context.", inputSchema: z.strictObject({}),
      execute: (_, { toolCallId }) => execute("get_mission_context", toolCallId, async () => modelData(await deps.describeSnapshot(input.snapshot, controller.signal))),
    }),
    preview_change: tool({
      description: "Evaluate a change without applying it. Only valid previews receive an ID.", inputSchema: deps.changeSchema,
      execute: (change, { toolCallId }) => execute("preview_change", toolCallId, async () => {
        const preview = await deps.previewChange(input.snapshot, change, controller.signal);
        if (controller.signal.aborted) return { error: "run-stopped" };
        if (preview.kind === "invalid") return { kind: "invalid", diagnostics: modelData(preview.diagnostics) };
        const summary = modelData(preview.summary);
        const previewId = randomUUID();
        previews.set(previewId, { change, candidate: preview.candidate, summary });
        return { kind: "valid", previewId, summary };
      }),
    }),
    propose_change: tool({
      description: "End with one previously validated preview for human review. Call alone.",
      inputSchema: z.strictObject({ previewId: z.string().min(1).max(64) }),
      execute: ({ previewId }, { toolCallId }) => execute("propose_change", toolCallId, async () => {
        const preview = previews.get(previewId);
        if (!preview) { fail("failed"); return { error: "unknown-preview" }; }
        run.state = { kind: "proposed", binding: parsed.data.binding, ...preview };
        return { kind: "proposed" };
      }),
    }),
    ask_clarification: tool({
      description: "End with a question when intent is incomplete. Call alone.",
      inputSchema: z.strictObject({ question: z.string().trim().min(1).max(1_000) }),
      execute: ({ question }, { toolCallId }) => execute("ask_clarification", toolCallId, async () => {
        run.state = { kind: "needs-input", question };
        return { kind: "needs-input" };
      }),
    }),
  };
  let removeAbort = () => {};
  const aborted = new Promise<undefined>((resolve) => {
    const listener = () => resolve(undefined);
    removeAbort = () => controller.signal.removeEventListener("abort", listener);
    controller.signal.addEventListener("abort", listener, { once: true });
    if (controller.signal.aborted) listener();
  });
  try {
    const generation = generateText({
      model: deps.model, tools, maxRetries: 0, maxOutputTokens: 1_000,
      experimental_telemetry: { isEnabled: false }, abortSignal: controller.signal,
      system: "You help preview mission edits. Never claim to apply, approve or fly a mission. Use only provided context. Ask clarification for missing intent. Preview before proposing. Terminal tools must be called alone.",
      messages: [...parsed.data.history, { role: "user", content: parsed.data.message }],
      stopWhen: [stepCountIs(limits.data.modelCalls), () => run.state.kind !== "running"],
      prepareStep: () => {
        if (controller.signal.aborted || run.state.kind !== "running") throw new Error("Run stopped");
        if (modelCalls >= limits.data.modelCalls) { fail("budget-exceeded"); throw new Error("Run stopped"); }
      },
      onLanguageModelCallStart: () => { modelCalls++; },
      onLanguageModelCallEnd: (event) => {
        if (controller.signal.aborted) return;
        const calls = event.content.filter((part) => part.type === "tool-call");
        if (event.finishReason !== "stop" && event.finishReason !== "tool-calls") { fail("failed"); return; }
        if (calls.some((call) => call.invalid || call.dynamic || call.providerExecuted || !(call.toolName in tools) || callIds.has(call.toolCallId)) || new Set(calls.map((call) => call.toolCallId)).size !== calls.length) { fail("failed"); return; }
        if (calls.some((call) => call.toolName === "propose_change" || call.toolName === "ask_clarification") && calls.length !== 1) { fail("failed"); return; }
        if (toolCalls + calls.length > limits.data.toolCalls) { fail("budget-exceeded"); return; }
        toolCalls += calls.length;
        for (const call of calls) { callIds.add(call.toolCallId); admitted.add(call.toolCallId); }
      },
    }).catch(() => { fail("failed"); return undefined; });
    const result = await Promise.race([generation, aborted]);
    if (run.state.kind !== "running") return { ...run.state, activity: [...activity] };
    if (!result) return { kind: "failed", activity: [...activity] };
    if (result.steps.at(-1)?.toolCalls.length) return { kind: "budget-exceeded", activity: [...activity] };
    const answer = agentMessageSchema.safeParse(result.text);
    if (result.finishReason !== "stop" || !answer.success) return { kind: "failed", activity: [...activity] };
    return { kind: "answered", text: answer.data, activity: [...activity] };
  } finally {
    clearTimeout(timer);
    removeAbort();
    deps.signal?.removeEventListener("abort", cancel);
  }
}
