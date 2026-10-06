export * from "./provider.js";
export * from "./prompt.js";
export * from "./convert.js";
export * from "./anthropic.js";
export * from "./openai.js";

import { AnthropicProvider } from "./anthropic.js";
import { OpenAiProvider } from "./openai.js";
import type { AiProvider } from "./provider.js";

export type ProviderName = "anthropic" | "openai";

export function createProvider(name: ProviderName, apiKey: string): AiProvider {
  if (name === "anthropic") return new AnthropicProvider(apiKey);
  if (name === "openai") return new OpenAiProvider(apiKey);
  throw new Error(`Unknown provider: ${name satisfies never}`);
}
