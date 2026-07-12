import type { z } from "zod";
import type { ChatTurn, GenerateOptions, LLMProvider, LLMConfig } from "./provider.js";

/**
 * Провайдер для будь-якого OpenAI-сумісного ендпоінта: локальний vLLM/ollama
 * (LLM_PROVIDER=local) або хмарний. Anthropic-провайдер — окремою реалізацією
 * того ж інтерфейсу (не додаємо тут, щоб не тягнути SDK у пакет).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(cfg: LLMConfig) {
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? "http://localhost:8000/v1").replace(/\/$/, "");
    this.apiKey = cfg.apiKey ?? "not-needed-for-local";
  }

  private async call(messages: ChatTurn[], opts: GenerateOptions, stream: boolean): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1024,
        stop: opts.stop,
        stream,
        // JSON-mode: змушує сервер (ollama/vLLM/OpenAI) повертати валідний JSON —
        // критично для надійного structured-виходу на реальних LLM.
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  }

  async generate(messages: ChatTurn[], opts: GenerateOptions = {}): Promise<string> {
    const res = await this.call(messages, opts, false);
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message.content ?? "";
  }

  async *stream(messages: ChatTurn[], opts: GenerateOptions = {}): AsyncIterable<string> {
    const res = await this.call(messages, opts, true);
    if (!res.ok || !res.body) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as { choices: { delta: { content?: string } }[] };
          const token = json.choices[0]?.delta.content;
          if (token) yield token;
        } catch {
          /* keep-alive/порожні кадри */
        }
      }
    }
  }

  async generateStructured<T>(
    messages: ChatTurn[],
    schema: z.ZodType<T>,
    opts: GenerateOptions = {},
  ): Promise<T> {
    // до 2 ретраїв на невалідний JSON, з фідбеком помилки в наступний запит
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const augmented: ChatTurn[] = attempt === 0
        ? messages
        : [...messages, { role: "user", content: `Попередня відповідь була невалідною: ${lastErr}. Поверни ЛИШЕ валідний JSON.` }];
      const raw = await this.generate(augmented, { ...opts, temperature: 0, jsonMode: true });
      const jsonText = extractJson(raw);
      const parsed = schema.safeParse(safeJsonParse(jsonText));
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
