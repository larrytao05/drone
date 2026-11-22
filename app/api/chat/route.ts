import "server-only";
import { createChatHandler } from "../../../web/server/chat-handler.ts";
import { getConfiguredModel } from "../../../web/server/model.ts";

export const runtime = "nodejs";

const handleChat = createChatHandler({
  getAccessToken: () => process.env.AGENT_API_TOKEN,
  getModel: getConfiguredModel,
});

export const POST = (request: Request) => handleChat(request);
