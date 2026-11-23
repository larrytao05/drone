import { describe, expect, it } from "vitest";
import { simulationResponseSchema } from "../src/simulation-contract.js";
import { createSimulationBridgeHandlers } from "../web/server/simulation-bridge.js";

describe("simulation bridge HTTP handlers", () => {
  it("rejects forbidden origins with 403", async () => {
    const handlers = createSimulationBridgeHandlers();
    const forbiddenReq = new Request("http://localhost:3000/api/simulation", {
      method: "POST",
      headers: {
        "origin": "https://malicious-website.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "status" }),
    });

    const res = await handlers.post(forbiddenReq);
    expect(res.status).toBe(403);
    const data = simulationResponseSchema.parse(await res.json());
    expect(data.ok ? null : data.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("rejects cross-site Sec-Fetch-Site with 403", async () => {
    const handlers = createSimulationBridgeHandlers();
    const crossSiteReq = new Request("http://localhost:3000/api/simulation", {
      method: "POST",
      headers: {
        "origin": "http://localhost:3000",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "status" }),
    });

    const res = await handlers.post(crossSiteReq);
    expect(res.status).toBe(403);
  });

  it("accepts valid local requests through GET and POST", async () => {
    const handlers = createSimulationBridgeHandlers();
    const getReq = new Request("http://localhost:3000/api/simulation", {
      method: "GET",
      headers: { "origin": "http://localhost:3000" },
    });

    const getRes = await handlers.get(getReq);
    expect(getRes.status).toBe(200);
    const getData = simulationResponseSchema.parse(await getRes.json());
    expect(getData.ok).toBe(true);
    expect(getData.status?.phase).toBe("ready");

    const postReq = new Request("http://localhost:3000/api/simulation", {
      method: "POST",
      headers: {
        "origin": "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "status" }),
    });

    const postRes = await handlers.post(postReq);
    expect(postRes.status).toBe(200);
    const postData = simulationResponseSchema.parse(await postRes.json());
    expect(postData.ok).toBe(true);
  });

  it("allows missing Origin on GET from loopback host, but rejects non-loopback host", async () => {
    const handlers = createSimulationBridgeHandlers();

    // Loopback host without Origin header
    const loopbackReq = new Request("http://localhost:3000/api/simulation", {
      method: "GET",
      headers: { host: "localhost:3000" },
    });
    const loopbackRes = await handlers.get(loopbackReq);
    expect(loopbackRes.status).toBe(200);

    // Non-loopback host without Origin header
    const nonLoopbackReq = new Request("http://remote.host:3000/api/simulation", {
      method: "GET",
      headers: { host: "remote.host:3000" },
    });
    const nonLoopbackRes = await handlers.get(nonLoopbackReq);
    expect(nonLoopbackRes.status).toBe(403);

    // Bracketed IPv6 loopback host without Origin header
    const ipv6Req = new Request("http://localhost:3000/api/simulation", {
      method: "GET",
      headers: { host: "[::1]:3000" },
    });
    const ipv6Res = await handlers.get(ipv6Req);
    expect(ipv6Res.status).toBe(200);

    // Missing host header without Origin header (untrusted request)
    const noHostReq = new Request("http://localhost:3000/api/simulation", {
      method: "GET",
      headers: {},
    });
    const noHostRes = await handlers.get(noHostReq);
    expect(noHostRes.status).toBe(403);
  });

  it("rejects mutating commands without Origin header to prevent broadening trust", async () => {
    const handlers = createSimulationBridgeHandlers();
    const noOriginCommandReq = new Request("http://localhost:3000/api/simulation", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "start" }),
    });

    const res = await handlers.post(noOriginCommandReq);
    expect(res.status).toBe(403);
    const data = simulationResponseSchema.parse(await res.json());
    expect(data.ok ? null : data.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("rejects invalid JSON or malformed command with 400", async () => {
    const handlers = createSimulationBridgeHandlers();
    const badReq = new Request("http://localhost:3000/api/simulation", {
      method: "POST",
      headers: {
        "origin": "http://localhost:3000",
        "content-type": "application/json",
      },
      body: "{ invalid json",
    });

    const res = await handlers.post(badReq);
    expect(res.status).toBe(400);
    const data = simulationResponseSchema.parse(await res.json());
    expect(data.ok ? null : data.error.code).toBe("INVALID_REQUEST");
  });
});
