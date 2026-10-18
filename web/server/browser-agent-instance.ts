import { createBrowserAgentHandlers } from "./browser-agent.ts";
import { getConfiguredModel } from "./model.ts";

declare global {
  var droneBrowserAgentHandlers: ReturnType<typeof createBrowserAgentHandlers> | undefined;
}

export const browserAgentHandlers = globalThis.droneBrowserAgentHandlers ??= createBrowserAgentHandlers({
  getEnvironment: () => ({
    AGENT_LOGIN_PASSWORD: process.env.AGENT_LOGIN_PASSWORD,
    AGENT_SESSION_SECRET: process.env.AGENT_SESSION_SECRET,
    AGENT_ALLOWED_ORIGIN: process.env.AGENT_ALLOWED_ORIGIN,
  }),
  getModel: getConfiguredModel,
});
