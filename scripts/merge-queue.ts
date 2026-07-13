/**
 * CLI для черги fuzzy-кандидатів на злиття (merge_queue). Resolver ставить сюди пари
 * товарів того самого бренду зі схожою назвою (Jaccard ≥ 0.6). Людина/політика вирішує.
 *
 * Запуск:
 *   pnpm tsx scripts/merge-queue.ts list [limit]         — показати pending з назвами
 *   pnpm tsx scripts/merge-queue.ts approve <queueId>    — злити пару (канонічний = повніший)
 *   pnpm tsx scripts/merge-queue.ts reject <queueId>     — відхилити кандидата
 *   pnpm tsx scripts/merge-queue.ts auto [threshold]     — авто-злити всі pending із sim ≥ threshold (деф. 0.9)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, products, mergeQueue } from "@wiki/db";
import { EventBus } from "@wiki/events";
import { MlClient, QdrantIndex } from "@wiki/retrieval";
import { memberStats, rankCanonical, absorbDuplicate, refreshCanonical, bestCategoryMedia, postMerge } from "./merge-core.js";

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

  console.error("Невідома команда. Використання: list | approve <id> | reject <id> | auto [threshold]");
  process.exit(1);
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
