import { eq, and, isNotNull, inArray } from "drizzle-orm";
import {
  createDb,
  productDrafts,
  products,
  productRevisions,
  productAttributes,
  productTexts,
  pageSnapshots,
  outbox,
} from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import type { EventOf } from "@wiki/contracts/events";

/**
 * Resolver-воркер: споживає `draft.normalized`, робить entity resolution
 * (точний матч GTIN → MPN+brand; fuzzy — TODO у чергу merge_queue), створює/оновлює
 * канонічний product + append-only revision + provenance-атрибути, публікує
 * `product.updated`. Скелет Фази 1: exact-match, без fuzzy-злиття.
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();

  console.log("resolver: підписка на", EventSubjects.DraftNormalized);

  await bus.subscribe(
    EventSubjects.DraftNormalized,
    "resolver",
    async (event: EventOf<typeof EventSubjects.DraftNormalized>) => {
      const { draftId } = event.payload;
      const [draft] = await db.select().from(productDrafts).where(eq(productDrafts.id, draftId)).limit(1);
      if (!draft || !draft.normalized) return;

      // 1. Exact match: GTIN, потім brand+MPN
      const existing = await findExisting(db, draft.brand, draft.mpn, draft.gtin);

      const revisionId = await db.transaction(async (tx) => {
        let productId = existing?.id;
        if (!productId) {
          const [p] = await tx
            .insert(products)
            .values({
              brand: draft.brand,
              name: draft.name,
              mpn: draft.mpn ?? null,
              gtin: draft.gtin ?? null,
              status: "active",
            })
            .returning({ id: products.id });
          productId = p!.id;
        }

        // provenance-атрибути (спрощено: перезапис по цьому джерелу)
        const attrs = (draft.attributesRaw as Array<{
          canonicalKey: string | null;
          value: unknown;
          unit: string | null;
          valueRaw: string;
        }>) ?? [];
        for (const a of attrs) {
          if (!a.canonicalKey) continue;
          await tx
            .insert(productAttributes)
            .values({
              productId,
              attrKey: a.canonicalKey,
              valueCanonical: a.value as never,
              unitCanonical: a.unit,
              valueRaw: a.valueRaw,
              sourceSnapshotId: draft.snapshotId,
            })
            .onConflictDoNothing();
        }

        // тексти
        const descriptions = (draft.descriptions as { section: string; text: string }[]) ?? [];
        for (const d of descriptions) {
          await tx.insert(productTexts).values({
            productId,
            section: d.section,
            lang: "uk",
            text: d.text,
            sourceSnapshotId: draft.snapshotId,
          });
        }

        // append-only revision — денормалізований знімок канонічної сутності
        const snapshot = await buildSnapshot(tx, productId);
        const [rev] = await tx
          .insert(productRevisions)
          .values({ productId, snapshot })
          .returning({ id: productRevisions.id });

        await tx.update(products).set({ currentRevisionId: rev!.id, updatedAt: new Date() }).where(eq(products.id, productId));
        await tx.update(productDrafts).set({ resolvedProductId: productId }).where(eq(productDrafts.id, draftId));

        await tx.insert(outbox).values({
          subject: EventSubjects.ProductUpdated,
          traceId: event.traceId,
          payload: {
            id: rev!.id, subject: EventSubjects.ProductUpdated, traceId: event.traceId,
            occurredAt: new Date().toISOString(),
            payload: { productId, revisionId: rev!.id },
          },
        });
        return rev!.id;
      });

      console.log(`resolved draft ${draftId} → revision ${revisionId}`);
    },
  );

  process.on("SIGTERM", async () => {
    await bus.drain();
    process.exit(0);
  });
}

async function findExisting(
  db: ReturnType<typeof createDb>,
  brand: string,
  mpn: string | null,
  gtin: string | null,
) {
  if (gtin) {
    const [byGtin] = await db.select().from(products).where(eq(products.gtin, gtin)).limit(1);
    if (byGtin) return byGtin;
  }
  if (mpn) {
    const [byMpn] = await db
      .select()
      .from(products)
      .where(and(eq(products.brand, brand), eq(products.mpn, mpn), isNotNull(products.mpn)))
      .limit(1);
    if (byMpn) return byMpn;
  }
  return null;
}

/** Транзакція або звичайне підключення — buildSnapshot працює з обома. */
type DbOrTx =
  | ReturnType<typeof createDb>
  | Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];

/** Денормалізований знімок для revision.snapshot (спрощено — тільки ключові поля). */
async function buildSnapshot(tx: DbOrTx, productId: string) {
  const [p] = await tx.select().from(products).where(eq(products.id, productId)).limit(1);
  const attrs = await tx.select().from(productAttributes).where(eq(productAttributes.productId, productId));
  const texts = await tx.select().from(productTexts).where(eq(productTexts.productId, productId));

  // provenance: реальні URL першоджерел (для цитат [n] у чаті). Збираємо унікальні
  // снапшоти, на які посилаються атрибути/тексти цього товару.
  const snapIds = [
    ...new Set([
      ...attrs.map((a) => a.sourceSnapshotId),
      ...texts.map((t) => t.sourceSnapshotId),
    ]),
  ];
  const snaps = snapIds.length
    ? await tx
        .select({
          id: pageSnapshots.id,
          url: pageSnapshots.url,
          sourceId: pageSnapshots.sourceId,
          fetchedAt: pageSnapshots.fetchedAt,
        })
        .from(pageSnapshots)
        .where(inArray(pageSnapshots.id, snapIds))
    : [];

  return {
    id: productId,
    brand: p?.brand,
    name: p?.name,
    categoryPath: [],
    attributes: attrs.map((a) => ({
      key: a.attrKey,
      valueCanonical: a.valueCanonical,
      unitCanonical: a.unitCanonical,
      valueRaw: a.valueRaw,
    })),
    texts: texts.map((t) => ({ section: t.section, text: t.text, lang: t.lang })),
    sources: snaps.map((s) => ({
      sourceId: s.sourceId,
      snapshotRef: s.id,
      url: s.url,
      fetchedAt: s.fetchedAt.toISOString(),
    })),
  };
}

main().catch((err) => {
  console.error("resolver fatal:", err);
  process.exit(1);
});
