import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AGENT_SCHEMA_VERSION, PLANNER_VERSION, digestMissionInput } from "../src/agent-contract.js";
import type { MissionInput } from "../src/index.js";
import { createBrowserAgentHandlers } from "../web/server/browser-agent.js";

const EPOCH = "a".repeat(32);
const NOW = 1_800_000_000_000;
const ORIGIN = "http://localhost:3105";
const PASSWORD = "fixture-password";
const SECRET = "fixture-session-secret-with-32-characters";
const snapshot: MissionInput = {
  shot: { kind: "route", anchors: [{ latitudeDeg: 40, longitudeDeg: -70 }, { latitudeDeg: 40.001, longitudeDeg: -70.001 }] },
  heightAboveTakeoffM: 20,
  framing: { kind: "fixed", headingDeg: 45, gimbalPitchDeg: -10 },
};
const binding = { missionBranchId: "branch", revision: 2, inputDigest: await digestMissionInput(snapshot), schemaVersion: AGENT_SCHEMA_VERSION, plannerVersion: PLANNER_VERSION };
const id = (epoch = EPOCH, at = NOW, suffix = "123e4567-e89b-42d3-a456-426614174000") => `${epoch}.${at}.${suffix}`;
const payload = (requestId = id()) => ({ requestId, message: "Change height", snapshot, binding });
const modelResponse = {
  content: [{ type: "text" as const, text: "No change needed" }], warnings: [],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
};
const model = () => new MockLanguageModelV3({ doGenerate: modelResponse });
const environment = () => ({ AGENT_LOGIN_PASSWORD: PASSWORD, AGENT_SESSION_SECRET: SECRET, AGENT_ALLOWED_ORIGIN: ORIGIN });
const post = (path: string, body: unknown, cookie?: string, origin = ORIGIN) => new Request(`${ORIGIN}${path}`, {
  method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
const read = async (response: Response) => ({ status: response.status, body: await response.json() });

async function sessionCookie(session: (request: Request) => Promise<Response>): Promise<string> {
  const response = await session(post("/api/agent/session", { action: "login", password: PASSWORD }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing test cookie");
  return cookie;
}

describe("browser agent boundary", () => {
  it("fails closed for configuration, origin, method and cookie errors", async () => {
    const getModel = vi.fn(model);
    const absent = createBrowserAgentHandlers({ getEnvironment: () => ({}), getModel, epoch: EPOCH, now: () => NOW });
    expect((await absent.session(post("/api/agent/session", { action: "status" }))).status).toBe(503);
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel, epoch: EPOCH, now: () => NOW });
    expect((await handlers.session(post("/api/agent/session", { action: "login", password: PASSWORD }, undefined, "http://evil.test"))).status).toBe(403);
    expect((await handlers.session(post("/api/agent/session", { action: "login", password: "wrong" }))).status).toBe(401);
    expect((await handlers.chat(post("/api/agent", payload()))).status).toBe(401);
    const cookie = await sessionCookie(handlers.session);
    expect(await read(await handlers.session(post("/api/agent/session", { action: "status" }, cookie)))).toEqual({ status: 200, body: { authenticated: true, epoch: EPOCH, serverNow: NOW, retryWindowMs: 120_000 } });
    expect((await handlers.chat(post("/api/agent", payload(), `${cookie}x`))).status).toBe(401);
    expect((await handlers.chat(post("/api/agent", payload(), cookie, "http://evil.test"))).status).toBe(403);
    expect((await handlers.chat(new Request(`${ORIGIN}/api/agent`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(payload()) }))).status).toBe(403);
    expect((await handlers.chat(new Request(`${ORIGIN}/api/agent`, { method: "GET", headers: { origin: ORIGIN, cookie } }))).status).toBe(405);
    expect((await handlers.session(post("/api/agent/session", { action: "logout" }, cookie))).headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await handlers.chat(post("/api/agent", payload(), cookie))).status).toBe(401);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("rejects unsafe deployment origins and bounds password bodies", async () => {
    const getModel = vi.fn(model);
    const unsafe = createBrowserAgentHandlers({ getEnvironment: () => ({ ...environment(), AGENT_ALLOWED_ORIGIN: "http://example.com" }), getModel, epoch: EPOCH, now: () => NOW });
    expect((await unsafe.session(post("/api/agent/session", { action: "status" }))).status).toBe(503);
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel, epoch: EPOCH, now: () => NOW });
    expect((await handlers.session(post("/api/agent/session", { action: "login", password: "x".repeat(2_000) }))).status).toBe(413);
    const secure = createBrowserAgentHandlers({ getEnvironment: () => ({ ...environment(), AGENT_ALLOWED_ORIGIN: "https://example.com" }), getModel, epoch: EPOCH, now: () => NOW });
    const login = await secure.session(new Request("https://example.com/api/agent/session", {
      method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" },
      body: JSON.stringify({ action: "login", password: PASSWORD }),
    }));
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(login.headers.get("set-cookie")).toContain("; Secure");
    expect(getModel).not.toHaveBeenCalled();
  });

  it("bounds login attempts and expires signed cookies", async () => {
    let now = NOW;
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel: model, epoch: EPOCH, now: () => now });
    const cookie = await sessionCookie(handlers.session);
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await handlers.session(post("/api/agent/session", { action: "login", password: "wrong" }))).status).toBe(401);
    expect((await handlers.session(post("/api/agent/session", { action: "login", password: PASSWORD }))).status).toBe(429);
    now += 8 * 60 * 60 * 1000;
    expect((await handlers.session(post("/api/agent/session", { action: "status" }, cookie))).status).toBe(200);
    expect(await (await handlers.session(post("/api/agent/session", { action: "status" }, cookie))).json()).toEqual({ authenticated: false });
  });

  it("rejects versions, digest, streamed body and old IDs before model work", async () => {
    const getModel = vi.fn(model);
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel, epoch: EPOCH, now: () => NOW });
    const cookie = await sessionCookie(handlers.session);
    expect((await handlers.chat(post("/api/agent", { ...payload(), binding: { ...binding, schemaVersion: "old" } }, cookie))).status).toBe(409);
    expect((await handlers.chat(post("/api/agent", { ...payload(), binding: { ...binding, inputDigest: `sha256:${"0".repeat(64)}` } }, cookie))).status).toBe(409);
    expect((await handlers.chat(post("/api/agent", payload(id("b".repeat(32))), cookie))).status).toBe(409);
    expect((await handlers.chat(post("/api/agent", payload(id(EPOCH, NOW - 120_000)), cookie))).status).toBe(409);
    const chunks = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32_768)); controller.enqueue(new Uint8Array(32_769)); controller.close(); } });
    const oversized = new Request(`${ORIGIN}/api/agent`, { method: "POST", headers: { origin: ORIGIN, cookie, "content-type": "application/json", "content-length": "1" }, body: chunks, duplex: "half" });
    expect((await handlers.chat(oversized)).status).toBe(413);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("joins and replays identical IDs, conflicts on changed content and retains a failure", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fake = new MockLanguageModelV3({ doGenerate: async () => { await pending; throw new Error("private-provider-detail"); } });
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel: () => fake, epoch: EPOCH, now: () => NOW });
    const cookie = await sessionCookie(handlers.session);
    const first = handlers.chat(post("/api/agent", payload(), cookie));
    await vi.waitFor(() => expect(fake.doGenerateCalls).toHaveLength(1));
    const duplicate = handlers.chat(post("/api/agent", { binding, snapshot, message: "Change height", requestId: id() }, cookie));
    expect((await handlers.chat(post("/api/agent", { ...payload(), message: "Another request" }, cookie))).status).toBe(409);
    release?.();
    const [a, b] = await Promise.all([first.then(read), duplicate.then(read)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 502, body: { requestId: id(), binding, outcome: { kind: "failed" } } });
    expect(JSON.stringify(a)).not.toContain("private-provider-detail");
    expect(await read(await handlers.chat(post("/api/agent", payload(), cookie)))).toEqual(a);
    const secondCookie = await sessionCookie(handlers.session);
    expect(await read(await handlers.chat(post("/api/agent", payload(), secondCookie)))).toEqual(a);
    expect(fake.doGenerateCalls).toHaveLength(1);
  });

  it("keeps admitted work after a disconnect and releases concurrency on completion", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fake = new MockLanguageModelV3({ doGenerate: async () => { await pending; return modelResponse; } });
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel: () => fake, epoch: EPOCH, now: () => NOW });
    const cookie = await sessionCookie(handlers.session);
    const controller = new AbortController();
    const firstRequest = post("/api/agent", payload(), cookie);
    const first = handlers.chat(new Request(firstRequest, { signal: controller.signal }));
    await vi.waitFor(() => expect(fake.doGenerateCalls).toHaveLength(1));
    controller.abort();
    release?.();
    const result = await read(await first);
    expect(result.status).toBe(200);
    expect(await read(await handlers.chat(post("/api/agent", payload(), cookie)))).toEqual(result);
    expect(fake.doGenerateCalls).toHaveLength(1);
    expect((await handlers.chat(post("/api/agent", payload(id(EPOCH, NOW, "123e4567-e89b-42d3-a456-426614174001")), cookie))).status).toBe(200);
  });

  it("rejects new work at the concurrency and rate limits", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fake = new MockLanguageModelV3({ doGenerate: async () => { await pending; return modelResponse; } });
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel: () => fake, epoch: EPOCH, now: () => NOW });
    const cookie = await sessionCookie(handlers.session);
    const first = handlers.chat(post("/api/agent", payload(id(EPOCH, NOW, "123e4567-e89b-42d3-a456-426614174001")), cookie));
    const second = handlers.chat(post("/api/agent", payload(id(EPOCH, NOW, "123e4567-e89b-42d3-a456-426614174002")), cookie));
    await vi.waitFor(() => expect(fake.doGenerateCalls).toHaveLength(2));
    expect((await handlers.chat(post("/api/agent", payload(id(EPOCH, NOW, "123e4567-e89b-42d3-a456-426614174003")), cookie))).status).toBe(429);
    expect(fake.doGenerateCalls).toHaveLength(2);
    release?.();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("holds admitted records through the retry window and limits new request rate", async () => {
    let now = NOW;
    const fake = model();
    const handlers = createBrowserAgentHandlers({ getEnvironment: environment, getModel: () => fake, epoch: EPOCH, now: () => now });
    const cookie = await sessionCookie(handlers.session);
    const numbered = (number: number) => payload(id(EPOCH, now, `123e4567-e89b-42d3-a456-${String(number).padStart(12, "0")}`));
    for (let number = 1; number <= 12; number += 1) expect((await handlers.chat(post("/api/agent", numbered(number), cookie))).status).toBe(200);
    expect((await handlers.chat(post("/api/agent", numbered(13), cookie))).status).toBe(429);
    now += 60_000;
    for (let number = 13; number <= 16; number += 1) expect((await handlers.chat(post("/api/agent", numbered(number), cookie))).status).toBe(200);
    expect((await handlers.chat(post("/api/agent", numbered(17), cookie))).status).toBe(503);
    expect(fake.doGenerateCalls).toHaveLength(16);
    now += 60_000;
    expect((await handlers.chat(post("/api/agent", payload(id(EPOCH, NOW, "123e4567-e89b-42d3-a456-000000000001")), cookie))).status).toBe(409);
    expect((await handlers.chat(post("/api/agent", numbered(18), cookie))).status).toBe(200);
  });

  it("rejects an admitted ID after a process epoch change", async () => {
    const firstModel = model();
    const first = createBrowserAgentHandlers({ getEnvironment: environment, getModel: () => firstModel, epoch: EPOCH, now: () => NOW });
    const oldCookie = await sessionCookie(first.session);
    expect((await first.chat(post("/api/agent", payload(), oldCookie))).status).toBe(200);
    const newModel = model();
    const restarted = createBrowserAgentHandlers({ getEnvironment: environment, getModel: () => newModel, epoch: "b".repeat(32), now: () => NOW });
    expect((await restarted.chat(post("/api/agent", payload(), oldCookie))).status).toBe(401);
    const newCookie = await sessionCookie(restarted.session);
    expect((await restarted.chat(post("/api/agent", payload(), newCookie))).status).toBe(409);
    expect(newModel.doGenerateCalls).toHaveLength(0);
  });
});
