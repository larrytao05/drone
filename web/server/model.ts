import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

export type ModelEnvironment = Readonly<{
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}>;

export function getConfiguredModel(
  environment?: ModelEnvironment,
  fetcher: typeof fetch = fetch,
): LanguageModel | undefined {
  const config = environment ?? {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
  };
  const apiKey = config.OPENAI_API_KEY?.trim();
  const modelId = config.OPENAI_MODEL?.trim();
  if (!apiKey || !modelId) return undefined;

  const provider = createOpenAI({ apiKey, baseURL: "https://api.openai.com/v1", fetch: fetcher });
  return wrapLanguageModel({
    model: provider.responses(modelId),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
  });
}
