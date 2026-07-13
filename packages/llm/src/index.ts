import type { LLMProvider, LLMConfig } from "./provider.js";
import { llmConfigFromEnv } from "./provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { DevLLMProvider } from "./dev.js";

export * from "./provider.js";
export * from "./prompts.js";
export { OpenAICompatibleProvider, AnthropicProvider, DevLLMProvider };

/** Фабрика провайдера за конфігом/env. */
export function createLLM(cfg: LLMConfig = llmConfigFromEnv()): LLMProvider {
  switch (cfg.provider) {
    case "dev":
      return new DevLLMProvider();
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "local":
    case "openai-compatible":
      return new OpenAICompatibleProvider(cfg);
    default:
      return new OpenAICompatibleProvider(cfg);
  }
}
