import "server-only";
import { createSimulationBridgeHandlers } from "../../../web/server/simulation-bridge.ts";

const bridge = createSimulationBridgeHandlers({ dockerMode: true });

function isBridgeOptedIn(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return (
    process.env.ENABLE_SIMULATION_BRIDGE === "1" ||
    process.env.ENABLE_SIMULATION_BRIDGE === "true" ||
    process.env.SIMULATION_ENABLED === "1"
  );
}

function disabledResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "FORBIDDEN_ORIGIN",
        message:
          "Simulation bridge is disabled. Set ENABLE_SIMULATION_BRIDGE=1 to enable in dev/local environments.",
      },
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isBridgeOptedIn()) {
    return disabledResponse();
  }
  return bridge.get(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!isBridgeOptedIn()) {
    return disabledResponse();
  }
  return bridge.post(request);
}
