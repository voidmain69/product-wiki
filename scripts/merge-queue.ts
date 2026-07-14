/**
 * CLI для черги fuzzy-кандидатів на злиття (merge_queue). Resolver ставить сюди пари
 * товарів того самого бренду зі схожою назвою (Jaccard ≥ 0.6). Людина/політика вирішує.
 *
 * Запуск:
 *   pnpm tsx scripts/merge-queue.ts list [limit]         — показати pending з назвами
 *   pnpm tsx scripts/merge-queue.ts approve <queueId>    — злити пару (канонічний = повніший)
 *   pnpm tsx scripts/merge-queue.ts reject <queueId>     — відхилити кандидата
 *   pnpm tsx scripts/merge-queue.ts auto [threshold]     — авто-злити всі pending із sim ≥ threshold (деф. 0.9)
 *   pnpm tsx scripts/merge-queue.ts triage [--apply]     — авто-тріаж усіх pending (approve/reject/human)
 *                                                          за політикою merge-triage (реальний BGE-M3!)
 *   pnpm tsx scripts/merge-queue.ts enqueue <leftId> <rightId>  — ручний кандидат (напр. крос-бренд)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, products, productAttributes, mergeQueue } from "@wiki/db";
import { EventBus } from "@wiki/events";
import { MlClient, QdrantIndex } from "@wiki/retrieval";
import { memberStats, rankCanonical, absorbDuplicate, refreshCanonical, bestCategoryMedia, postMerge } from "./merge-core.js";
import {
  type AttrLite,
  identifierConflict,
  attrConflictStats,
  cosine,
  triageDecision,
} from "../services/resolver/src/merge-triage.js";

const ROOT = join(import.meta.dirname, "..");

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* дефолти оточення */
  }
}

interface Candidate {
  id: string;
  similarity: number;
  leftId: string;
  rightId: string;
  leftName: string | null;
  rightName: string | null;
  brand: string | null;
}

/** pending-кандидати з назвами обох товарів (тільки де обидва ще активні). */
async function pending(db: ReturnType<typeof createDb>, limit = 200): Promise<Candidate[]> {
  return (await db.execute(sql`
    select mq.id, mq.similarity, mq.left_product_id as "leftId", mq.right_product_id as "rightId",
           l.name as "leftName", r.name as "rightName", l.brand
    from ${mergeQueue} mq
    join ${products} l on l.id = mq.left_product_id
    join ${products} r on r.id = mq.right_product_id
    where mq.status = 'pending' and l.status = 'active' and r.status = 'active'
    order by mq.similarity desc
    limit ${limit}
  `)) as unknown as Candidate[];
}

async function main() {
  loadEnv();
  const cmd = process.argv[2] ?? "list";
  const db = createDb();

  if (cmd === "list") {
    const rows = await pending(db, Number(process.argv[3] ?? 50));
    if (!rows.length) return console.log("Черга порожня (немає активних pending-кандидатів).");
    console.log(`${rows.length} pending-кандидатів (sim desc):\n`);
    for (const c of rows) {
      console.log(`  ${c.id.slice(0, 8)}  sim=${Number(c.similarity).toFixed(2)}  [${c.brand}]`);
      console.log(`      L ${c.leftId.slice(0, 8)}  ${c.leftName}`);
      console.log(`      R ${c.rightId.slice(0, 8)}  ${c.rightName}`);
    }
    console.log(`\nЗлити: merge-queue.ts approve <id> · Відхилити: reject <id> · Авто: auto [threshold]`);
    process.exit(0);
  }

  if (cmd === "reject") {
    const id = requireId();
    await db.update(mergeQueue).set({ status: "rejected", decidedBy: "cli" }).where(eq(mergeQueue.id, id));
    console.log(`✓ кандидата ${id.slice(0, 8)} відхилено`);
    process.exit(0);
  }

  if (cmd === "approve" || cmd === "auto") {
    const bus = await EventBus.connect();
    const qdrant = new QdrantIndex(new MlClient());
    const toPurge: string[] = [];
    const toReindex: { productId: string; revisionId: string }[] = [];

    const all = await pending(db, 2000);
    const candidates =
      cmd === "approve"
        ? all.filter((c) => c.id === requireId() || c.id.startsWith(requireId()))
        : all.filter((c) => Number(c.similarity) >= Number(process.argv[3] ?? 0.9));

    if (cmd === "auto") console.log(`• авто-злиття ${candidates.length} кандидатів (sim ≥ ${process.argv[3] ?? 0.9})`);
    if (!candidates.length) {
      console.log("Немає кандидатів під критерій.");
      await bus.drain();
      process.exit(0);
    }

    let merged = 0;
    for (const c of candidates) {
      const ordered = rankCanonical(await memberStats(db, [c.leftId, c.rightId]));
      if (ordered.length < 2) {
        // один із товарів уже неактивний (злитий раніше) — просто закриваємо кандидата
        await db.update(mergeQueue).set({ status: "merged", decidedBy: "cli" }).where(eq(mergeQueue.id, c.id));
        continue;
      }
      const [canonical, dup] = ordered;
      const { categoryPath, media } = bestCategoryMedia(ordered);
      const revisionId = await db.transaction(async (tx) => {
        await absorbDuplicate(tx, canonical!.id, dup!.id);
        return refreshCanonical(tx, canonical!.id, categoryPath, media);
      });
      await db.update(mergeQueue).set({ status: "merged", decidedBy: "cli" }).where(eq(mergeQueue.id, c.id));
      toPurge.push(dup!.id);
      toReindex.push({ productId: canonical!.id, revisionId });
      merged++;
      console.log(`  ✓ ${c.brand}: ${dup!.id.slice(0, 8)} → ${canonical!.id.slice(0, 8)} (${canonical!.attrs} attrs)`);
    }

    console.log(`✓ злито ${merged} пар`);
    await postMerge(bus, qdrant, toPurge, toReindex);
    process.exit(0);
  }

  if (cmd === "enqueue") {
    const left = process.argv[3];
    const right = process.argv[4];
    if (!left || !right) {
      console.error("Потрібні <leftId> <rightId>.");
      process.exit(1);
    }
    const both = await db
      .select({ id: products.id })
      .from(products)
      .where(and(inArray(products.id, [left, right]), eq(products.status, "active")));
    if (both.length < 2) {
      console.error("Обидва товари мають існувати й бути active.");
      process.exit(1);
    }
    await db.insert(mergeQueue).values({ leftProductId: left, rightProductId: right, similarity: 1, status: "pending" });
    console.log(`✓ кандидата додано в чергу: ${left.slice(0, 8)} ↔ ${right.slice(0, 8)} (triage/approve вирішить)`);
    process.exit(0);
  }

  if (cmd === "triage") {
    const apply = process.argv.includes("--apply");
    const ml = new MlClient();
    const rows = await pending(db, 2000);
    if (!rows.length) {
      console.log("Черга порожня.");
      process.exit(0);
    }

    // Метадані кожного унікального товару (ідентифікатори + дедуплікований набір атрибутів).
    const metas = new Map<string, { name: string; mpn: string | null; gtin: string | null; attrs: AttrLite[] }>();
    for (const c of rows) {
      for (const id of [c.leftId, c.rightId]) if (!metas.has(id)) metas.set(id, await productMeta(db, id));
    }

    // Ембединги назв — ОДНИМ батчем (гарно для TEI); ML down → cosine 0 → нічого не апрувиться.
    const ids = [...metas.keys()];
    let vecById = new Map<string, number[]>();
    try {
      const out = await ml.embed(ids.map((id) => metas.get(id)!.name));
      vecById = new Map(ids.map((id, i) => [id, out[i]!.dense]));
    } catch (e) {
      console.warn(`⚠ ML недоступний (${(e as Error).message}) — косинус назв = 0, авто-approve вимкнено; лишаються лише reject за ідентифікаторами/атрибутами.`);
    }

    const decided: { c: (typeof rows)[number]; verdict: string; reason: string }[] = [];
    for (const c of rows) {
      const L = metas.get(c.leftId)!, R = metas.get(c.rightId)!;
      const lv = vecById.get(c.leftId), rv = vecById.get(c.rightId);
      const nameCosine = lv && rv ? cosine(lv, rv) : 0;
      const { agreeing, conflicting } = attrConflictStats(L.attrs, R.attrs);
      const res = triageDecision({
        identifierConflict: identifierConflict(L, R),
        conflictingAttrs: conflicting,
        agreeingAttrs: agreeing,
        nameCosine,
      });
      decided.push({ c, verdict: res.verdict, reason: res.reason });
    }

    const by = (v: string) => decided.filter((d) => d.verdict === v);
    for (const v of ["approve", "reject", "human"] as const) {
      const list = by(v);
      console.log(`\n── ${v.toUpperCase()} (${list.length}) ──`);
      for (const d of list) {
        console.log(`  ${d.c.id.slice(0, 8)}  [${d.c.brand}]  ${d.reason}`);
        console.log(`      L ${d.c.leftName}\n      R ${d.c.rightName}`);
      }
    }
    console.log(`\nРазом: approve=${by("approve").length} reject=${by("reject").length} human=${by("human").length}`);

    if (!apply) {
      console.log("\n(dry-run) Запусти з --apply, щоб застосувати approve+reject. human лишаються для merge-queue.ts approve.");
      process.exit(0);
    }

    // Застосування: reject — просто статус; approve — злиття через merge-core.
    const bus = await EventBus.connect();
    const qdrant = new QdrantIndex(ml);
    for (const d of by("reject")) {
      await db.update(mergeQueue).set({ status: "rejected", decidedBy: "triage" }).where(eq(mergeQueue.id, d.c.id));
    }
    const toPurge: string[] = [];
    const toReindex: { productId: string; revisionId: string }[] = [];
    let merged = 0;
    for (const d of by("approve")) {
      const ordered = rankCanonical(await memberStats(db, [d.c.leftId, d.c.rightId]));
      if (ordered.length < 2) {
        await db.update(mergeQueue).set({ status: "merged", decidedBy: "triage" }).where(eq(mergeQueue.id, d.c.id));
        continue;
      }
      const [canonical, dup] = ordered;
      const { categoryPath, media } = bestCategoryMedia(ordered);
      const revisionId = await db.transaction(async (tx) => {
        await absorbDuplicate(tx, canonical!.id, dup!.id);
        return refreshCanonical(tx, canonical!.id, categoryPath, media);
      });
      await db.update(mergeQueue).set({ status: "merged", decidedBy: "triage" }).where(eq(mergeQueue.id, d.c.id));
      toPurge.push(dup!.id);
      toReindex.push({ productId: canonical!.id, revisionId });
      merged++;
      console.log(`  ✓ ${d.c.brand}: ${dup!.id.slice(0, 8)} → ${canonical!.id.slice(0, 8)}`);
    }
    console.log(`✓ застосовано: reject ${by("reject").length}, merge ${merged}; human ${by("human").length} лишились.`);
    await postMerge(bus, qdrant, toPurge, toReindex);
    process.exit(0);
  }

  console.error("Невідома команда. Використання: list | approve <id> | reject <id> | auto [threshold] | triage [--apply] | enqueue <leftId> <rightId>");
  process.exit(1);
}

/** Ідентифікатори + дедуплікований (за ключем) набір канонічних значень атрибутів товару. */
async function productMeta(
  db: ReturnType<typeof createDb>,
  id: string,
): Promise<{ name: string; mpn: string | null; gtin: string | null; attrs: AttrLite[] }> {
  const [p] = await db
    .select({ name: products.name, mpn: products.mpn, gtin: products.gtin })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  const rows = await db
    .select({ key: productAttributes.attrKey, value: productAttributes.valueCanonical })
    .from(productAttributes)
    .where(eq(productAttributes.productId, id));
  const byKey = new Map<string, unknown>();
  for (const r of rows) if (!byKey.has(r.key)) byKey.set(r.key, r.value); // 1 значення на ключ (провенанс-дублі рівні)
  return {
    name: p?.name ?? "",
    mpn: p?.mpn ?? null,
    gtin: p?.gtin ?? null,
    attrs: [...byKey].map(([key, value]) => ({ key, value })),
  };
}

function requireId(): string {
  const id = process.argv[3];
  if (!id) {
    console.error("Потрібен <queueId> (перші 8 символів достатньо — див. list).");
    process.exit(1);
  }
  return id;
}

main().catch((e) => {
  console.error("merge-queue error:", e?.message ?? e);
  process.exit(1);
});
