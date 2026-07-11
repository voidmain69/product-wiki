import { inArray, eq } from "drizzle-orm";
import type { Database } from "@wiki/db";
import { productAttributes, attributeOntology } from "@wiki/db";
import type { ComparisonTable } from "@wiki/contracts";

/**
 * Детермінований diff канонічних атрибутів — БУДУЄТЬСЯ КОДОМ, не LLM.
 * Тому таблиця порівняння завжди точна; LLM лише коментує значущі відмінності.
 */
export async function buildComparison(
  db: Database,
  productIds: string[],
  productNames: string[],
): Promise<ComparisonTable> {
  const rows = await db
    .select({
      productId: productAttributes.productId,
      attrKey: productAttributes.attrKey,
      valueRaw: productAttributes.valueRaw,
      label: attributeOntology.label,
    })
    .from(productAttributes)
    .innerJoin(attributeOntology, eq(productAttributes.attrKey, attributeOntology.key))
    .where(inArray(productAttributes.productId, productIds));

  // групування attrKey → значення по кожному товару
  const byAttr = new Map<string, { label: string; values: Map<string, string> }>();
  for (const r of rows) {
    const entry = byAttr.get(r.attrKey) ?? { label: r.label, values: new Map() };
    entry.values.set(r.productId, r.valueRaw);
    byAttr.set(r.attrKey, entry);
  }

  const tableRows = [...byAttr.entries()].map(([attrKey, { label, values }]) => {
    const cells = productIds.map((pid) => values.get(pid) ?? null);
    const distinct = new Set(cells.filter((c) => c !== null));
    return { attrKey, label, values: cells, differs: distinct.size > 1 };
  });

  return { productIds, productNames, rows: tableRows };
}
