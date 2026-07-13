import { and, eq, ilike, or, sql, desc, asc, inArray, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createDb,
  products,
  productAttributes,
  productTexts,
  attributeOntology,
  pageSnapshots,
  productRevisions,
} from "@wiki/db";
import type {
  ProductDetail,
  ProductListItem,
  ProductListResponse,
  ProductFacets,
} from "@wiki/contracts";
import { parseListParams } from "./products-query.js";

/**
 * REST для SSR-сторінок товарів («вікіпедія»). apps/web не має доступу до БД
 * (інваріант карти монорепо) — тягне ці DTO через HTTP. Кожен атрибут повертається
 * з provenance (URL + дата снапшота), бо факт без джерела не показуємо.
 */
export async function registerProductRoutes(app: FastifyInstance): Promise<void> {
  const db = createDb();

  // Каталог: пошук + фільтри (бренд/категорія) + сортування + пагінація.
  // Повертає сторінку та повну кількість (для пагінації в UI).
  app.get("/products", async (req) => {
    const p = parseListParams(req.query as Record<string, unknown>);
    const where = listWhere(p);

    // total для пагінації — окремим дешевим count(*) з тим самим фільтром
    const [{ n: total }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(products)
      .where(where)) as [{ n: number }];

    const rows = await db
      .select({
        productId: products.id,
        brand: products.brand,
        name: products.name,
        categoryPath: products.categoryPath,
        thumbnail: products.thumbnail,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .where(where)
      .orderBy(...orderBy(p.sort))
      .limit(p.limit)
      .offset(p.offset);

    const items: ProductListItem[] = [];
    for (const r of rows) {
      // повторні знімки лишають дублі атрибутів (та сама мітка з різних snapshot) —
      // дедуплікуємо за міткою й беремо 3 ключові. categoryPath/thumbnail — денормалізовані
      // у products (без читання величезного snapshot).
      const specRows = await db
        .select({ label: attributeOntology.label, value: productAttributes.valueRaw, unit: productAttributes.unitCanonical })
        .from(productAttributes)
        .innerJoin(attributeOntology, eq(productAttributes.attrKey, attributeOntology.key))
        .where(eq(productAttributes.productId, r.productId))
        .limit(24);
      const keySpecs: { label: string; value: string }[] = [];
      const seenLabel = new Set<string>();
      for (const s of specRows) {
        if (seenLabel.has(s.label)) continue;
        seenLabel.add(s.label);
        keySpecs.push({ label: s.label, value: `${s.value}${s.unit ? " " + s.unit : ""}` });
        if (keySpecs.length >= 3) break;
      }
      items.push({
        productId: r.productId,
        brand: r.brand,
        name: r.name,
        categoryPath: r.categoryPath ?? [],
        thumbnail: r.thumbnail && /^https?:\/\//.test(r.thumbnail) ? r.thumbnail : null,
        keySpecs,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    const body: ProductListResponse = { items, total };
    return body;
  });

  // Фасети для фільтрів — контекстні: кожен вимір рахується з урахуванням ІНШИХ активних
  // фільтрів. Тобто список категорій звужується до обраного бренду (обрав вендора →
  // бачиш лише його категорії), а список брендів — до обраної категорії; обидва — за q.
  // Власний вимір не застосовуємо, щоб можна було перемикатися всередині нього.
  app.get("/products/facets", async (req) => {
    const { q: rawQ, brand, category } = req.query as { q?: string; brand?: string; category?: string };
    const q = rawQ?.trim() || undefined;

    const qCond = q ? sql` and (${products.name} ilike ${"%" + q + "%"} or ${products.brand} ilike ${"%" + q + "%"})` : sql``;
    const brandCond = brand ? sql` and ${products.brand} = ${brand}` : sql``;
    const catCond = category ? sql` and ${products.categoryPath} @> ${JSON.stringify([category])}::jsonb` : sql``;

    // бренди: звужені за обраною категорією (+q), але НЕ за брендом — щоб перемикатися
    const brandRows = await db.execute<{ value: string; count: number }>(sql`
      select ${products.brand} as value, count(*)::int as count
      from ${products}
      where ${products.status} = 'active'${qCond}${catCond}
      group by ${products.brand}
      order by count desc, value asc
      limit 60
    `);

    // категорії: звужені за обраним брендом (+q), але НЕ за категорією. categoryPath —
    // денормалізований масив у products (без читання ревізій), тож розкладаємо й рахуємо рівні.
    const catRows = await db.execute<{ value: string; count: number }>(sql`
      select elem as value, count(*)::int as count
      from ${products}
      cross join lateral jsonb_array_elements_text(${products.categoryPath}) as elem
      where ${products.status} = 'active'${qCond}${brandCond}
      group by elem
      order by count desc, value asc
      limit 40
    `);

    const facets: ProductFacets = {
      brands: [...brandRows].map((r) => ({ value: r.value, count: Number(r.count) })),
      categories: [...catRows].map((r) => ({ value: r.value, count: Number(r.count) })),
    };
    return facets;
  });

  // Деталі товару з provenance на кожен атрибут/текст
  app.get("/products/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!p) {
      reply.code(404);
      return { error: "not found" };
    }

    const attrRows = await db
      .select({
        key: productAttributes.attrKey,
        label: attributeOntology.label,
        value: productAttributes.valueRaw,
        unit: productAttributes.unitCanonical,
        snapId: productAttributes.sourceSnapshotId,
      })
      .from(productAttributes)
      .innerJoin(attributeOntology, eq(productAttributes.attrKey, attributeOntology.key))
      .where(eq(productAttributes.productId, id));

    const textRows = await db
      .select({ section: productTexts.section, text: productTexts.text, snapId: productTexts.sourceSnapshotId })
      .from(productTexts)
      .where(eq(productTexts.productId, id));

    // мапа снапшот → url/дата (provenance)
    const snapIds = [...new Set([...attrRows.map((a) => a.snapId), ...textRows.map((t) => t.snapId)])];
    const snaps = snapIds.length
      ? await db
          .select({ id: pageSnapshots.id, url: pageSnapshots.url, fetchedAt: pageSnapshots.fetchedAt })
          .from(pageSnapshots)
          .where(inArray(pageSnapshots.id, snapIds))
      : [];
    const snapById = new Map(snaps.map((s) => [s.id, s]));

    // categoryPath — денормалізований у products; зображення беремо зі знімка (один товар).
    const categoryPath = p.categoryPath ?? [];
    const snap = await revisionSnapshot(db, p.currentRevisionId);
    const images = (snap?.media ?? [])
      .filter((m) => m.type === "image" && /^https?:\/\//.test(m.url))
      .map((m) => m.url);

    // Дедуплікація: повторні знімки того самого товару лишають дублі атрибутів/текстів
    // (та сама мітка з різних sourceSnapshotId). Показуємо по одному запису на атрибут —
    // із найсвіжішим provenance (останній знімок), щоб «вікі» була чистою й актуальною.
    const attrByKey = new Map<string, { row: (typeof attrRows)[number]; date: Date }>();
    for (const a of attrRows) {
      const s = snapById.get(a.snapId);
      if (!s) continue;
      const prev = attrByKey.get(a.key);
      if (!prev || s.fetchedAt > prev.date) attrByKey.set(a.key, { row: a, date: s.fetchedAt });
    }
    const textSeen = new Set<string>();

    const detail: ProductDetail = {
      productId: p.id,
      brand: p.brand,
      name: p.name,
      mpn: p.mpn,
      gtin: p.gtin,
      categoryPath,
      updatedAt: p.updatedAt.toISOString(),
      images,
      attributes: [...attrByKey.values()].flatMap(({ row: a }) => {
        const s = snapById.get(a.snapId)!;
        return [{ key: a.key, label: a.label, value: a.value, unit: a.unit, sourceUrl: s.url, snapshotDate: s.fetchedAt.toISOString() }];
      }),
      texts: textRows.flatMap((t) => {
        const s = snapById.get(t.snapId);
        if (!s) return [];
        const dedupeKey = `${t.section}::${t.text}`;
        if (textSeen.has(dedupeKey)) return [];
        textSeen.add(dedupeKey);
        return [{ section: t.section, text: t.text, sourceUrl: s.url }];
      }),
      sources: snaps.map((s) => ({ url: s.url, fetchedAt: s.fetchedAt.toISOString() })),
    };
    return detail;
  });
}

/** WHERE каталогу: активні + пошук(name|brand) + бренд + категорія (jsonb-масив знімка). */
function listWhere(p: ReturnType<typeof parseListParams>): SQL | undefined {
  const conds: SQL[] = [eq(products.status, "active")];
  if (p.q) {
    const like = `%${p.q}%`;
    conds.push(or(ilike(products.name, like), ilike(products.brand, like))!);
  }
  if (p.brand) conds.push(eq(products.brand, p.brand));
  if (p.category) {
    // categoryPath денормалізований у products (GIN ix_product_category_gin) — containment
    // б'є лише в поточні товари (1 рядок/товар), без детоасту history-ревізій.
    conds.push(sql`${products.categoryPath} @> ${JSON.stringify([p.category])}::jsonb`);
  }
  return and(...conds);
}

/** ORDER BY за ключем сортування (свіжість/назва/бренд). */
function orderBy(sort: ReturnType<typeof parseListParams>["sort"]): SQL[] {
  if (sort === "name") return [asc(products.name)];
  if (sort === "brand") return [asc(products.brand), asc(products.name)];
  return [desc(products.updatedAt)];
}

interface RevisionSnapshot {
  categoryPath?: string[];
  media?: { type: string; url: string }[];
}

/** Знімок поточної ревізії (denormalized): categoryPath, media тощо. */
async function revisionSnapshot(
  db: ReturnType<typeof createDb>,
  revisionId: string | null,
): Promise<RevisionSnapshot | null> {
  if (!revisionId) return null;
  const [rev] = await db
    .select({ snapshot: productRevisions.snapshot })
    .from(productRevisions)
    .where(eq(productRevisions.id, revisionId))
    .limit(1);
  return (rev?.snapshot as RevisionSnapshot) ?? null;
}
