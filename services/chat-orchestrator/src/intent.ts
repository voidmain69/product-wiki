import { z } from "zod";
import type { LLMProvider } from "@wiki/llm";
import { SYSTEM_INTENT } from "@wiki/llm";
import type { ChatIntent, RetrievalFilters } from "@wiki/contracts";

/** Розуміння запиту: intent + фільтри + перефразування для пошуку. */

const IntentFilters = z.object({
  categoryPath: z.array(z.string()).optional(),
  brand: z.string().optional(),
  productNames: z.array(z.string()).optional(), // для compare/info
  attrRanges: z
    .record(z.object({ gte: z.number().optional(), lte: z.number().optional() }))
    .optional(),
});

// Схема LLM-виходу ТОЛЕРАНТНА (реальні моделі іноді пропускають поля).
export const IntentResult = z.object({
  intent: z.enum(["info", "recommend", "compare", "followup", "out_of_scope"]),
  searchQuery: z.string().optional(),
  filters: IntentFilters.optional(),
});

/** Нормалізований intent з ГАРАНТОВАНИМИ полями (для orchestrator). */
export interface ResolvedIntent {
  intent: z.infer<typeof IntentResult>["intent"];
  searchQuery: string;
  filters: z.infer<typeof IntentFilters>;
}

export async function classifyIntent(
  llm: LLMProvider,
  message: string,
  history: { role: string; content: string }[],
): Promise<ResolvedIntent> {
  const historyBlock = history
    .slice(-6)
    .map((h) => `${h.role}: ${h.content}`)
    .join("\n");
  const r = await llm.generateStructured(
    [
      { role: "system", content: SYSTEM_INTENT },
      { role: "user", content: `ІСТОРІЯ:\n${historyBlock}\n\nЗАПИТ: ${message}` },
    ],
    IntentResult,
  );
  // нормалізуємо: гарантуємо searchQuery (добиваємо з повідомлення) і filters
  return {
    intent: r.intent,
    searchQuery: r.searchQuery?.trim() || message,
    filters: r.filters ?? {},
  };
}

export function toRetrievalFilters(r: ResolvedIntent): RetrievalFilters {
  return {
    categoryPath: r.filters.categoryPath,
    brand: r.filters.brand,
    attrRanges: r.filters.attrRanges,
  };
}

export type { ChatIntent };
