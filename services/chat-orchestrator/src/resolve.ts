import { ilike, or } from "drizzle-orm";
import type { Database } from "@wiki/db";
import { products } from "@wiki/db";

/** Резолвинг товарів за назвою (для intent info/compare). Спрощено: ILIKE-матч. */
export async function resolveProductsByName(
  db: Database,
  names: string[],
): Promise<{ id: string; name: string }[]> {
  const conditions = names.map((n) => ilike(products.name, `%${n}%`));
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(or(...conditions))
    .limit(names.length * 2);

  // по одному найкращому матчу на кожну назву
  const picked: { id: string; name: string }[] = [];
  for (const n of names) {
    const match = rows.find((r) => r.name.toLowerCase().includes(n.toLowerCase()));
    if (match && !picked.some((p) => p.id === match.id)) picked.push(match);
  }
  return picked;
}
