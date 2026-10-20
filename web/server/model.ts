import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

export type ModelEnvironment = Readonly<{
  AGENT_MODEL_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
}>;

export function getConfiguredModel(
  environment?: ModelEnvironment,
  fetcher: typeof fetch = fetch,
): LanguageModel | undefined {
  const config = environment ?? {
    AGENT_MODEL_PROVIDER: process.env.AGENT_MODEL_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  };
  const selectedProvider = config.AGENT_MODEL_PROVIDER?.trim() || "openai";
  if (selectedProvider === "openrouter") {
    const apiKey = config.OPENROUTER_API_KEY?.trim();
    const modelId = config.OPENROUTER_MODEL?.trim() || "openrouter/free";
    if (!apiKey || (modelId !== "openrouter/free" && !modelId.endsWith(":free"))) return undefined;

    const provider = createOpenAI({ name: "openrouter", apiKey, baseURL: "https://openrouter.ai/api/v1", fetch: fetcher });
    return provider.chat(modelId);
  }
  if (selectedProvider !== "openai") return undefined;

  const apiKey = config.OPENAI_API_KEY?.trim();
  const modelId = config.OPENAI_MODEL?.trim();
  if (!apiKey || !modelId) return undefined;

  const provider = createOpenAI({ apiKey, baseURL: "https://api.openai.com/v1", fetch: fetcher });
  return wrapLanguageModel({
    model: provider.responses(modelId),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
  });
}
