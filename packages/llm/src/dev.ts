import type { z } from "zod";
import type { ChatTurn, GenerateOptions, LLMProvider } from "./provider.js";

/**
 * Детермінований LLM-провайдер для локального E2E/CI без реальної моделі
 * (аналог ML_DEV_MODE). НЕ для продакшну — не «розуміє» тексту, а працює
 * евристиками, ЗБЕРІГАЮЧИ інваріанти чату:
 *   - intent класифікується за ключовими словами (реальний детермінований роутинг);
 *   - відповідь будується ЛИШЕ з наданого КОНТЕКСТУ і несе маркери [n] (guardrail);
 *   - бракує контексту → чесне «немає даних».
 * Реальний LLM — заміна конфігу (LLM_PROVIDER=local|anthropic).
 */
export class DevLLMProvider implements LLMProvider {
  readonly model = "dev-deterministic";

  async generate(messages: ChatTurn[], _opts?: GenerateOptions): Promise<string> {
    const user = lastUser(messages);
    if (user.includes("КОНТЕКСТ:")) return citedAnswer(user);
    // usecase / коментар порівняння тощо — короткий детермінований текст
    return "Згенеровано в dev-режимі (реальна модель не підключена).";
  }

  async *stream(messages: ChatTurn[], opts?: GenerateOptions): AsyncIterable<string> {
    const text = await this.generate(messages, opts);
    // токенізуємо по словах, щоб відтворити стрімінг
    for (const tok of text.match(/\S+\s*/g) ?? [text]) yield tok;
  }

  async generateStructured<T>(
    messages: ChatTurn[],
    schema: z.ZodType<T>,
    _opts?: GenerateOptions,
  ): Promise<T> {
    // Єдиний structured-виклик у чаті — класифікація intent. Будуємо кандидата
    // з евристик і валідуємо схемою (як зробила б реальна модель).
    const candidate = classifyIntent(lastUser(messages));
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    // інша схема — повертаємо порожній об'єкт (best-effort для dev)
    const fallback = schema.safeParse({});
    if (fallback.success) return fallback.data;
    throw new Error("DevLLMProvider: не вдалося задовольнити схему structured-виходу");
  }
}

/* ── евристики ────────────────────────────────────────────────────────── */

function lastUser(messages: ChatTurn[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return "";
}

/** Витягує «ЗАПИТ: …» з intent-промпта або бере весь текст. */
function extractQuery(userContent: string): string {
  const m = userContent.match(/ЗАПИТ:\s*([\s\S]*)$/);
  return (m?.[1] ?? userContent).trim();
}

interface IntentCandidate {
  intent: "info" | "recommend" | "compare" | "followup" | "out_of_scope";
  searchQuery: string;
  filters: { productNames?: string[] };
}

export function classifyIntent(userContent: string): IntentCandidate {
  const q = extractQuery(userContent);
  const low = q.toLowerCase();

  if (/порівн|\bvs\b|versus|що краще|чи краще/.test(low)) {
    // грубе виділення назв: розбиваємо за сполучниками
    const names = q
      .split(/\s+(?:і|та|проти|vs|versus)\s+/i)
      .map((s) => s.replace(/порівняй|порівняти|comparison|compare/gi, "").trim())
      .filter((s) => s.length > 1);
    return { intent: "compare", searchQuery: q, filters: { productNames: names } };
  }
  if (/порад|підбери|рекоменд|підкажи|для\s+(квартир|дому|потреб)|до\s+\d/.test(low)) {
    return { intent: "recommend", searchQuery: q, filters: {} };
  }
  if (/привіт|дякую|хто ти|як справи|погода|анекдот/.test(low)) {
    return { intent: "out_of_scope", searchQuery: q, filters: {} };
  }
  // за замовчуванням — інформаційний запит про товар
  return { intent: "info", searchQuery: q, filters: {} };
}

/** Будує відповідь ЛИШЕ з блоків [n] у КОНТЕКСТІ, додаючи маркери-цитати. */
function citedAnswer(userContent: string): string {
  const ctx = userContent.split("ПИТАННЯ:")[0] ?? "";
  const blocks = [...ctx.matchAll(/\[(\d+)\]([\s\S]*?)(?=\n\[\d+\]|\nПИТАННЯ:|$)/g)];
  if (blocks.length === 0) {
    return "У мене немає даних про це від виробника.";
  }
  const parts: string[] = ["За даними виробника:"];
  for (const b of blocks.slice(0, 3)) {
    const n = b[1];
    const snippet = (b[2] ?? "")
      .replace(/Джерело:.*$/m, "")
      .replace(/\(товар[^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    if (snippet) parts.push(`${snippet} [${n}]`);
  }
  return parts.join(" ");
}
