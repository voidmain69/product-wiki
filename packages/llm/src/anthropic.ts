import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { ChatTurn, GenerateOptions, LLMProvider, LLMConfig } from "./provider.js";

/**
 * Провайдер на офіційному Anthropic SDK (Messages API). Той самий інтерфейс
 * LLMProvider, що й OpenAI-compatible — сервіси не змінюються, лише конфіг
 * (LLM_PROVIDER=anthropic, LLM_MODEL=claude-opus-4-8, LLM_API_KEY).
 *
 * Нюанси Messages API: system — окреме поле (не роль у messages); temperature
 * на сучасних моделях відхиляється (400), тож не передаємо; max_tokens обов'язковий.
 */
export class AnthropicProvider implements LLMProvider {
  readonly model: string;
  private client: Anthropic;

  constructor(cfg: LLMConfig) {
    this.model = cfg.model;
    this.client = new Anthropic({
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    });
  }

  /** Розділяє наші ChatTurn на system-рядок і user/assistant-повідомлення. */
  private split(messages: ChatTurn[]): { system?: string; msgs: { role: "user" | "assistant"; content: string }[] } {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const msgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    return { system: system || undefined, msgs };
  }

  async generate(messages: ChatTurn[], opts: GenerateOptions = {}): Promise<string> {
    const { system, msgs } = this.split(messages);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      ...(opts.stop ? { stop_sequences: opts.stop } : {}),
      messages: msgs,
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  async *stream(messages: ChatTurn[], opts: GenerateOptions = {}): AsyncIterable<string> {
    const { system, msgs } = this.split(messages);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      ...(opts.stop ? { stop_sequences: opts.stop } : {}),
      messages: msgs,
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
  }

  /**
   * Structured-вихід через промпт + zod-валідацію з ретраями. Не залежимо від
   * конвертації zod→json_schema (наші схеми містять discriminated unions тощо),
   * тому просимо JSON текстом і валідуємо — так само, як OpenAI-провайдер.
   */
  async generateStructured<T>(messages: ChatTurn[], schema: z.ZodType<T>, opts: GenerateOptions = {}): Promise<T> {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const augmented: ChatTurn[] =
        attempt === 0
          ? messages
          : [...messages, { role: "user", content: `Попередня відповідь була невалідною: ${lastErr}. Поверни ЛИШЕ валідний JSON.` }];
      const raw = await this.generate(augmented, opts);
      const parsed = schema.safeParse(safeJsonParse(extractJson(raw)));
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.message.slice(0, 300);
    }
    throw new Error(`generateStructured failed after retries: ${lastErr}`);
  }
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
