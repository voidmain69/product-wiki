/**
 * Спільна логіка злиття дублів товарів (append-only): переносить атрибути/тексти/
 * чернетки на канонічний, позначає дубль merged_away, будує дедуплікований знімок
 * і свіжу ревізію. Використовується scripts/merge-duplicates.ts (точні дублі) і
 * scripts/merge-queue.ts (fuzzy-кандидати).
 */
import { eq, inArray, sql } from "drizzle-orm";
import type {
  createDb} from "@wiki/db";
import {
  products,
  productAttributes,
  productTexts,
  productRevisions,
  pageSnapshots,
} from "@wiki/db";
import type { EventBus} from "@wiki/events";
import { EventSubjects } from "@wiki/events";
import type { QdrantIndex } from "@wiki/retrieval";

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

export interface MemberStat {
  id: string;
  attrs: number;
  categoryPath: string[];
  media: { type: string; url: string }[];
  createdAt: Date;
}

/** Статистика товарів для вибору канонічного (найбільше унікальних атрибутів → канонічний). */
export async function memberStats(db: Db, ids: string[]): Promise<MemberStat[]> {
  if (!ids.length) return [];
  const rows = (await db.execute(sql`
    select p.id,
           count(distinct pa.attr_key)::int as attrs,
           coalesce(r.snapshot -> 'categoryPath', '[]'::jsonb) as category_path,
           coalesce(r.snapshot -> 'media', '[]'::jsonb) as media,
           r.created_at
    from ${products} p
    left join ${productAttributes} pa on pa.product_id = p.id
    left join ${productRevisions} r on r.id = p.current_revision_id
    where p.id in ${ids} and p.status = 'active'
    group by p.id, r.snapshot, r.created_at
  `)) as unknown as {
    id: string;
    attrs: number;
    category_path: string[];
    media: { type: string; url: string }[];
    created_at: Date | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    attrs: Number(r.attrs),
    categoryPath: Array.isArray(r.category_path) ? r.category_path : [],
    media: Array.isArray(r.media) ? r.media : [],
    createdAt: r.created_at ? new Date(r.created_at) : new Date(0),
  }));
}

/** Впорядкування: найповніший першим (канонічний), tiebreak — стабільно за id. */
export function rankCanonical(members: MemberStat[]): MemberStat[] {
  return [...members].sort((a, b) => b.attrs - a.attrs || a.id.localeCompare(b.id));
}

/** Переносить один дубль у канонічний (у межах переданої транзакції). */
export async function absorbDuplicate(tx: Tx, canonicalId: string, dupId: string): Promise<void> {
  // атрибути: переносимо ті, що не порушать унікальний (product,attr_key,snapshot);
  // решту (дублі провенансу) прибираємо — вони вже є в канонічного.
  await tx.execute(sql`
    update ${productAttributes} pa set product_id = ${canonicalId}
    where pa.product_id = ${dupId}
      and not exists (
        select 1 from ${productAttributes} c
        where c.product_id = ${canonicalId} and c.attr_key = pa.attr_key and c.source_snapshot_id = pa.source_snapshot_id
      )
  `);
  await tx.execute(sql`delete from ${productAttributes} where product_id = ${dupId}`);
  await tx.execute(sql`update ${productTexts} set product_id = ${canonicalId} where product_id = ${dupId}`);
  await tx.execute(sql`update product_drafts set resolved_product_id = ${canonicalId} where resolved_product_id = ${dupId}`);
  await tx
    .update(products)
    .set({ status: "merged_away", mergedInto: canonicalId, updatedAt: new Date() })
    .where(eq(products.id, dupId));
}

/** Свіжа ревізія канонічного + оновлення denormalized полів; повертає revisionId. */
export async function refreshCanonical(
  tx: Tx,
  canonicalId: string,
  categoryPath: string[],
  media: { type: string; url: string }[],
): Promise<string> {
  const snapshot = await buildSnapshot(tx, canonicalId);
  snapshot.categoryPath = categoryPath;
  snapshot.media = media;
  const [rev] = await tx.insert(productRevisions).values({ productId: canonicalId, snapshot }).returning({ id: productRevisions.id });
  const thumbnail = media.find((m) => m.type === "image" && /^https?:\/\//.test(m.url))?.url ?? null;
  await tx
    .update(products)
    .set({ currentRevisionId: rev!.id, categoryPath, thumbnail, updatedAt: new Date() })
    .where(eq(products.id, canonicalId));
  return rev!.id;
}

/** Дедуплікований знімок (1 рядок на attr_key — найсвіжіший provenance). */
export async function buildSnapshot(tx: DbOrTx, productId: string) {
  const [p] = await tx.select().from(products).where(eq(products.id, productId)).limit(1);
  const attrs = await tx.select().from(productAttributes).where(eq(productAttributes.productId, productId));
  const texts = await tx.select().from(productTexts).where(eq(productTexts.productId, productId));
  const snapIds = [...new Set([...attrs.map((a) => a.sourceSnapshotId), ...texts.map((t) => t.sourceSnapshotId)])];
  const snaps = snapIds.length
    ? await tx.select({ id: pageSnapshots.id, url: pageSnapshots.url, sourceId: pageSnapshots.sourceId, fetchedAt: pageSnapshots.fetchedAt }).from(pageSnapshots).where(inArray(pageSnapshots.id, snapIds))
    : [];
  const snapDate = new Map(snaps.map((s) => [s.id, s.fetchedAt]));

  const byKey = new Map<string, (typeof attrs)[number]>();
  for (const a of attrs) {
    const prev = byKey.get(a.attrKey);
    if (!prev || (snapDate.get(a.sourceSnapshotId) ?? new Date(0)) > (snapDate.get(prev.sourceSnapshotId) ?? new Date(0))) {
      byKey.set(a.attrKey, a);
    }
  }

  return {
    id: productId,
    brand: p?.brand,
    name: p?.name,
    categoryPath: [] as string[],
    media: [] as { type: string; url: string }[],
    attributes: [...byKey.values()].map((a) => ({ key: a.attrKey, valueCanonical: a.valueCanonical, unitCanonical: a.unitCanonical, valueRaw: a.valueRaw })),
    texts: texts.map((t) => ({ section: t.section, text: t.text, lang: t.lang })),
    sources: snaps.map((s) => ({ sourceId: s.sourceId, snapshotRef: s.id, url: s.url, fetchedAt: s.fetchedAt.toISOString() })),
  };
}

/** categoryPath/media для канонічного — перший непорожній серед членів (канонічний → решта). */
export function bestCategoryMedia(ordered: MemberStat[]): { categoryPath: string[]; media: { type: string; url: string }[] } {
  return {
    categoryPath: ordered.map((m) => m.categoryPath).find((c) => c.length) ?? [],
    media: ordered.map((m) => m.media).find((m) => m.length) ?? [],
  };
}

/** Пост-обробка після злиття: best-effort Qdrant-очистка дублів + product.updated для канонічних. */
export async function postMerge(
  bus: Awaited<ReturnType<typeof EventBus.connect>>,
  qdrant: QdrantIndex,
  toPurge: string[],
  toReindex: { productId: string; revisionId: string }[],
): Promise<void> {
  let purged = 0;
  for (const id of toPurge) {
    try {
      await qdrant.deleteProduct(id);
      purged++;
    } catch {
      break; // Qdrant недоступний — не спамимо
    }
  }
  if (toPurge.length) console.log(purged ? `✓ Qdrant: прибрано точки ${purged}/${toPurge.length} дублів` : `⚠ Qdrant недоступний — точки дублів лишаться до reindex`);

  for (const r of toReindex) {
    await bus
      .publish(EventSubjects.ProductUpdated, {
        id: `merge-${r.revisionId}`,
        subject: EventSubjects.ProductUpdated,
        traceId: `merge-${r.productId}`,
        occurredAt: new Date().toISOString(),
        payload: { productId: r.productId, revisionId: r.revisionId },
      })
      .catch(() => void 0);
  }
  if (toReindex.length) console.log(`✓ емітнуто product.updated для ${toReindex.length} канонічних (indexer переіндексує, коли ML up)`);
  await bus.drain();
}
