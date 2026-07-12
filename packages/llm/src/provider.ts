import type { z } from "zod";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Змусити сервер повертати валідний JSON (response_format json_object). */
  jsonMode?: boolean;
}

/**
 * Абстракція над LLM — провайдер конфігурується (local vLLM/ollama, Anthropic,
 * OpenAI-compatible), а не зашивається. Сервіси залежать лише від цього інтерфейсу.
 */
export interface LLMProvider {
  readonly model: string;

  /** Звичайна генерація. */
  generate(messages: ChatTurn[], opts?: GenerateOptions): Promise<string>;

  /** Стрімінг токенів (для чат-відповідей через SSE). */
  stream(messages: ChatTurn[], opts?: GenerateOptions): AsyncIterable<string>;

  /**
   * Структурований вихід зі схемою — модель зобов'язана повернути валідний JSON.
   * Валідація zod'ом з ретраєм на невідповідність (реалізується в провайдері).
   */
  generateStructured<T>(messages: ChatTurn[], schema: z.ZodType<T>, opts?: GenerateOptions): Promise<T>;
}

export interface LLMConfig {
  provider: "local" | "anthropic" | "openai-compatible" | "dev";
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

export function llmConfigFromEnv(): LLMConfig {
  const devMode = (process.env.LLM_DEV_MODE ?? "").toLowerCase();
  const provider =
    devMode === "1" || devMode === "true"
      ? "dev"
      : (process.env.LLM_PROVIDER as LLMConfig["provider"]) ?? "local";
  return {
    provider,
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL ?? "qwen2.5-14b-instruct",
  };
}
