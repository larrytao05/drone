import "server-only";
import { browserAgentHandlers } from "../../../web/server/browser-agent-instance.ts";

export const runtime = "nodejs";
export const POST = browserAgentHandlers.chat;
