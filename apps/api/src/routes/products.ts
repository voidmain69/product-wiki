import { eq, ilike, desc, inArray } from "drizzle-orm";
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
import type { ProductDetail, ProductListItem } from "@wiki/contracts";

/**
 * REST для SSR-сторінок товарів («вікіпедія»). apps/web не має доступу до БД
 * (інваріант карти монорепо) — тягне ці DTO через HTTP. Кожен атрибут повертається
 * з provenance (URL + дата снапшота), бо факт без джерела не показуємо.
 */
export async function registerProductRoutes(app: FastifyInstance): Promise<void> {
  const db = createDb();

  // Список / пошук за назвою (для індексної сторінки та автокомпліту)
  app.get("/products", async (req) => {
    const q = (req.query as { q?: string }).q?.trim();
    const rows = await db
      .select({
        productId: products.id,
        brand: products.brand,
        name: products.name,
        revisionId: products.currentRevisionId,
      })
      .from(products)
      .where(q ? ilike(products.name, `%${q}%`) : undefined)
      .orderBy(desc(products.updatedAt))
      .limit(50);

    const items: ProductListItem[] = [];
    for (const r of rows) {
      const specs = await db
        .select({ label: attributeOntology.label, value: productAttributes.valueRaw, unit: productAttributes.unitCanonical })
        .from(productAttributes)
        .innerJoin(attributeOntology, eq(productAttributes.attrKey, attributeOntology.key))
        .where(eq(productAttributes.productId, r.productId))
        .limit(3);
      // categoryPath і фото — зі знімка поточної ревізії (денормалізовано в resolver)
      const snap = await revisionSnapshot(db, r.revisionId);
      items.push({
        productId: r.productId,
        brand: r.brand,
        name: r.name,
        categoryPath: snap?.categoryPath ?? [],
        thumbnail: firstImage(snap?.media),
        keySpecs: specs.map((s) => ({ label: s.label, value: `${s.value}${s.unit ? " " + s.unit : ""}` })),
      });
    }
    return { items };
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

    const snap = await revisionSnapshot(db, p.currentRevisionId);
    const categoryPath = snap?.categoryPath ?? [];
    const images = (snap?.media ?? [])
      .filter((m) => m.type === "image" && /^https?:\/\//.test(m.url))
      .map((m) => m.url);

    const detail: ProductDetail = {
      productId: p.id,
      brand: p.brand,
      name: p.name,
      mpn: p.mpn,
      gtin: p.gtin,
      categoryPath,
      updatedAt: p.updatedAt.toISOString(),
      images,
      attributes: attrRows.flatMap((a) => {
        const s = snapById.get(a.snapId);
        return s
          ? [{ key: a.key, label: a.label, value: a.value, unit: a.unit, sourceUrl: s.url, snapshotDate: s.fetchedAt.toISOString() }]
          : [];
      }),
      texts: textRows.flatMap((t) => {
        const s = snapById.get(t.snapId);
        return s ? [{ section: t.section, text: t.text, sourceUrl: s.url }] : [];
      }),
      sources: snaps.map((s) => ({ url: s.url, fetchedAt: s.fetchedAt.toISOString() })),
    };
    return detail;
  });
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

/** Перше валідне http-зображення з медіа знімка. */
function firstImage(media: { type: string; url: string }[] | undefined): string | null {
  return media?.find((m) => m.type === "image" && /^https?:\/\//.test(m.url))?.url ?? null;
}
