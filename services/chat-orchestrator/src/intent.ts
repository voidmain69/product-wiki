import { z } from "zod";
import type { LLMProvider } from "@wiki/llm";
import { SYSTEM_INTENT } from "@wiki/llm";
import type { ChatIntent, RetrievalFilters } from "@wiki/contracts";

/** Розуміння запиту: intent + фільтри + перефразування для пошуку. */

export const IntentResult = z.object({
  intent: z.enum(["info", "recommend", "compare", "followup", "out_of_scope"]),
  searchQuery: z.string(), // переформульований для retrieval
  filters: z.object({
    categoryPath: z.array(z.string()).optional(),
    brand: z.string().optional(),
    productNames: z.array(z.string()).optional(), // для compare/info
    attrRanges: z
      .record(z.object({ gte: z.number().optional(), lte: z.number().optional() }))
      .optional(),
  }),
});
export type IntentResult = z.infer<typeof IntentResult>;

export async function classifyIntent(
  llm: LLMProvider,
  message: string,
  history: { role: string; content: string }[],
): Promise<IntentResult> {
  const historyBlock = history
    .slice(-6)
    .map((h) => `${h.role}: ${h.content}`)
    .join("\n");
  return llm.generateStructured(
    [
      { role: "system", content: SYSTEM_INTENT },
      { role: "user", content: `ІСТОРІЯ:\n${historyBlock}\n\nЗАПИТ: ${message}` },
    ],
    IntentResult,
  );
}

export function toRetrievalFilters(r: IntentResult): RetrievalFilters {
  return {
    categoryPath: r.filters.categoryPath,
    brand: r.filters.brand,
    attrRanges: r.filters.attrRanges,
  };
}

export type { ChatIntent };
