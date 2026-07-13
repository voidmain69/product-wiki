import { eq, and, isNotNull, inArray, ilike, ne, sql } from "drizzle-orm";
import {
  createDb,
  productDrafts,
  products,
  productRevisions,
  productAttributes,
  productTexts,
  pageSnapshots,
  mergeQueue,
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

      // 1. Exact match: GTIN → brand+MPN → URL товару → brand+name
      const [snap] = await db
        .select({ url: pageSnapshots.url })
        .from(pageSnapshots)
        .where(eq(pageSnapshots.id, draft.snapshotId))
        .limit(1);
      const existing = await findExisting(db, draft.brand, draft.mpn, draft.gtin, draft.name, snap?.url ?? null);

      const revisionId = await db.transaction(async (tx) => {
        let productId = existing?.id;
        if (!productId) {
          // onConflict за partial-unique (brand,name) WHERE active закриває гонку: якщо
          // інший консюмер щойно вставив цей самий товар — insert нічого не поверне,
          // і ми беремо наявний (замість створення дубля).
          const inserted = await tx
            .insert(products)
            .values({
              brand: draft.brand,
              name: draft.name,
              mpn: draft.mpn ?? null,
              gtin: draft.gtin ?? null,
              status: "active",
            })
            .onConflictDoNothing({ target: [products.brand, products.name], where: sql`status = 'active'` })
            .returning({ id: products.id });
          if (inserted[0]) {
            productId = inserted[0].id;
          } else {
            const [ex] = await tx
              .select({ id: products.id })
              .from(products)
              .where(and(eq(products.brand, draft.brand), eq(products.name, draft.name), eq(products.status, "active")))
              .limit(1);
            productId = ex!.id;
          }
        } else if (looksLikeSlug(existing!.name) && /\s/.test(draft.name)) {
          // назва базової сторінки часом «слизька» (ProArt-Display-PA278QV-Gen2);
          // чистіша назва з BreadcrumbList /techspec/ ("ProArt Display PA278QV") — краща.
          await tx.update(products).set({ name: draft.name }).where(eq(products.id, productId));
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
            // Мова джерела з драфта; легасі-драфти без мови → BC-дефолт "uk".
            lang: draft.lang ?? "uk",
            text: d.text,
            sourceSnapshotId: draft.snapshotId,
          });
        }

        // append-only revision — денормалізований знімок канонічної сутності.
        // categoryPath беремо з крихт джерела (draft), доки нема власної таксономії.
        const snapshot = await buildSnapshot(tx, productId);
        snapshot.categoryPath = (draft.categoryRaw as string[]) ?? [];
        // медіа (фото товару) — з крихт джерела; денормалізуємо в знімок ревізії,
        // щоб картки/вікі показували реальні зображення без окремої таблиці.
        snapshot.media = (draft.media as { type: string; url: string }[]) ?? [];
        const [rev] = await tx
          .insert(productRevisions)
          .values({ productId, snapshot })
          .returning({ id: productRevisions.id });

        // денормалізуємо у products поля каталогу (categoryPath, thumbnail) з поточної
        // ревізії — щоб фільтр/фасети/список не читали величезний snapshot усіх ревізій.
        const thumbnail =
          snapshot.media.find((m) => m.type === "image" && /^https?:\/\//.test(m.url))?.url ?? null;
        await tx
          .update(products)
          .set({ currentRevisionId: rev!.id, categoryPath: snapshot.categoryPath, thumbnail, updatedAt: new Date() })
          .where(eq(products.id, productId));
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
        return { revisionId: rev!.id, productId: productId!, created: !existing };
      });

      // Fuzzy resolution: новий товар міг бути дублем наявного (варіант назви без
      // спільного MPN/URL) — не зливаємо автоматично (append-only), а ставимо
      // кандидата в merge_queue на рішення (людина/авто-політика).
      if (revisionId.created) {
        await enqueueMergeCandidate(db, revisionId.productId, draft.brand, draft.name).catch(() => void 0);
      }
      console.log(`resolved draft ${draftId} → revision ${revisionId.revisionId}`);
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
  name: string,
  url: string | null,
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
  // URL-родина товару: базова сторінка й .../techspec/ належать одному товару. Матчимо
  // через попередній draft із канонічним URL — надійніший ключ за назву (джерела без
  // MPN/GTIN, напр. ASUS), і не плодить дублів при збагаченні спеками.
  if (url) {
    const cands = urlCandidates(url);
    const [byUrl] = await db
      .select({ pid: productDrafts.resolvedProductId })
      .from(productDrafts)
      .innerJoin(pageSnapshots, eq(productDrafts.snapshotId, pageSnapshots.id))
      .where(and(inArray(pageSnapshots.url, cands), isNotNull(productDrafts.resolvedProductId)))
      .limit(1);
    if (byUrl?.pid) {
      const [p] = await db.select().from(products).where(eq(products.id, byUrl.pid)).limit(1);
      if (p) return p;
    }
  }
  // Fallback exact-match brand+name (коли ще нема resolved-draft із цим URL).
  // Fuzzy-злиття варіантів назв — TODO merge_queue.
  if (name) {
    const [byName] = await db
      .select()
      .from(products)
      .where(and(eq(products.brand, brand), eq(products.name, name)))
      .limit(1);
    if (byName) return byName;
  }
  return null;
}

/** Канонічні форми URL товару: сам URL і його база без хвоста /techspec/. */
function urlCandidates(url: string): string[] {
  const set = new Set<string>([url]);
  const base = url.replace(/techspec\/?$/i, "");
  set.add(base);
  set.add(base.endsWith("/") ? base : base + "/");
  return [...set];
}

/** Схоже на slug (є дефіси, нема пробілів), напр. "ProArt-Display-PA278QV-Gen2". */
function looksLikeSlug(s: string): boolean {
  return /-/.test(s) && !/\s/.test(s);
}

/**
 * Ставить кандидата на злиття, якщо серед товарів того ж бренду є схожа назва.
 * Пошук обмежуємо за модель-токеном (ILIKE), схожість — Jaccard за токенами.
 * Не зливаємо тут — лише черга на рішення (fuzzy → merge_queue).
 */
async function enqueueMergeCandidate(
  db: ReturnType<typeof createDb>,
  newProductId: string,
  brand: string,
  name: string,
): Promise<void> {
  const token = modelToken(name);
  if (!token) return;
  const cands = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.brand, brand), ilike(products.name, `%${token}%`), ne(products.id, newProductId)))
    .limit(10);

  let best: { id: string; sim: number } | null = null;
  for (const c of cands) {
    const sim = nameSimilarity(name, c.name);
    if (!best || sim > best.sim) best = { id: c.id, sim };
  }
  if (best && best.sim >= 0.6 && best.sim < 1) {
    await db
      .insert(mergeQueue)
      .values({ leftProductId: best.id, rightProductId: newProductId, similarity: best.sim, status: "pending" })
      .onConflictDoNothing();
  }
}

/** Найдовший алфа-цифровий токен із цифрою (модель-код, напр. "PA278QV"), інакше — найдовший. */
function modelToken(name: string): string | null {
  const tokens = name.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  const withDigit = tokens.filter((t) => /\d/.test(t)).sort((a, b) => b.length - a.length);
  return withDigit[0] ?? tokens.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Jaccard за нормалізованими токенами назви (0..1). */
function nameSimilarity(a: string, b: string): number {
  const toks = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const A = toks(a);
  const B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
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
    categoryPath: [] as string[],
    media: [] as { type: string; url: string }[],
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
