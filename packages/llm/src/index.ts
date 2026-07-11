import type { LLMProvider, LLMConfig } from "./provider.js";
import { llmConfigFromEnv } from "./provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { DevLLMProvider } from "./dev.js";

export * from "./provider.js";
export * from "./prompts.js";
export { OpenAICompatibleProvider, DevLLMProvider };

/** Фабрика провайдера за конфігом/env. Anthropic-гілка додається тут при потребі. */
export function createLLM(cfg: LLMConfig = llmConfigFromEnv()): LLMProvider {
  switch (cfg.provider) {
    case "dev":
      return new DevLLMProvider();
    case "local":
    case "openai-compatible":
      return new OpenAICompatibleProvider(cfg);
    case "anthropic":
      // TODO: AnthropicProvider (той самий інтерфейс) — див. packages/llm/README
      return new OpenAICompatibleProvider(cfg);
    default:
      return new OpenAICompatibleProvider(cfg);
  }
}
