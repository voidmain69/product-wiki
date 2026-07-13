/**
 * BC: застосовує пропозицію злиття синонім-ключів онтології (ontology-proposal.json,
 * який пише scripts/ontology-cluster.ts) — зводить крос-мовні дублі («weight» → «вага»)
 * до одного канонічного ключа. Без LLM (інваріанти 4/5/7). Ідемпотентно.
 *
 * Потік: ontology-cluster.ts → рев'ю/редагування JSON → ontology-apply.ts [--dry].
 * Формат кластера у synClusters — АБО масив `[{key,label,n}, ...]` (канонічний = перший,
 * найуживаніший), АБО обʼєкт `{ "canonical": "<key>", "keys": [{key},...] }` (ручний вибір).
 *
 * Для кожного дубля:
 *   1) re-point product_attributes.attr_key → target (WHERE NOT EXISTS, щоб не впасти на
 *      uq_attr_product_key_source), потім DELETE залишків;
 *   2) злиття aliases (target ∪ {dup.key, dup.label} ∪ dup.aliases);
 *   3) DELETE dup з attribute_ontology.
 * Далі — свіжа ревізія кожного зачепленого товару + product.updated (indexer переіндексує;
 * сам reindex.ts не досить — snapshot старої ревізії має старі ключі).
 *
 * УВАГА: після apply перезапусти normalizer — його in-memory aliasIndex може ще тримати
 * видалений dup-ключ і провіжнити його знову.
 *
 * Запуск: pnpm tsx scripts/ontology-apply.ts [--dry]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  attributeOntology,
  productAttributes,
  products,
  productRevisions,
} from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { refreshCanonical } from "./merge-core.js";

const ROOT = join(import.meta.dirname, "..");
const IN = process.env.ONTOLOGY_OUT ?? join(ROOT, "ontology-proposal.json");
const DRY = process.argv.includes("--dry");

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* дефолти */
  }
}

type ClusterItem = { key: string; label?: string; n?: number };
type Cluster = ClusterItem[] | { canonical?: string; keys: ClusterItem[] };

/** Нормалізує кластер до { target, dups } незалежно від формату (масив / обʼєкт). */
function normalizeCluster(c: Cluster): { target: string; dups: string[] } {
  const items = Array.isArray(c) ? c : c.keys;
  const keys = items.map((i) => i.key).filter(Boolean);
  const target = (!Array.isArray(c) && c.canonical) || keys[0]!;
  const dups = keys.filter((k) => k !== target);
  return { target, dups };
}

async function main() {
  loadEnv();
  const db = createDb();

  const proposal = JSON.parse(readFileSync(IN, "utf8")) as { synClusters?: Cluster[] };
  const clusters = (proposal.synClusters ?? []).map(normalizeCluster).filter((c) => c.dups.length);
  if (!clusters.length) {
    console.log(`Нема кластерів для злиття у ${IN}`);
    process.exit(0);
  }
  console.log(`• ${clusters.length} кластер(ів) на злиття${DRY ? " (DRY)" : ""}`);

  const affected = new Set<string>();
  let repointed = 0;
  let mergedKeys = 0;

  // ── Крок 1: re-point атрибутів + злиття aliases + видалення dup-ключів ────
  for (const { target, dups } of clusters) {
    for (const dup of dups) {
      const prodRows = (await db.execute(sql`
        select distinct product_id from ${productAttributes} where attr_key = ${dup}
      `)) as unknown as { product_id: string }[];
      for (const r of prodRows) affected.add(r.product_id);

      console.log(`  ${dup} → ${target}  (${prodRows.length} товар(ів))`);
      if (DRY) {
        repointed += prodRows.length;
        mergedKeys++;
        continue;
      }

      await db.transaction(async (tx) => {
        // 1. перенос атрибутів, що не порушать унікальний (product, attr_key, snapshot)
        await tx.execute(sql`
          update ${productAttributes} pa set attr_key = ${target}
          where pa.attr_key = ${dup}
            and not exists (
              select 1 from ${productAttributes} c
              where c.product_id = pa.product_id and c.attr_key = ${target}
                and c.source_snapshot_id = pa.source_snapshot_id
            )
        `);
        // 2. залишки-дублі того ж провенансу — прибираємо (вони вже є під target)
        await tx.execute(sql`delete from ${productAttributes} where attr_key = ${dup}`);
        // 3. злиття aliases у target (union з ключем і міткою дубля)
        const [t] = await tx.select().from(attributeOntology).where(eq(attributeOntology.key, target)).limit(1);
        const [d] = await tx.select().from(attributeOntology).where(eq(attributeOntology.key, dup)).limit(1);
        if (t && d) {
          const merged = [...new Set([...(t.aliases ?? []), ...(d.aliases ?? []), d.key, d.label])];
          await tx.update(attributeOntology).set({ aliases: merged }).where(eq(attributeOntology.key, target));
        }
        // 4. видалення dup-ключа (FK product_attributes уже перекинуто на target)
        if (d) await tx.execute(sql`delete from ${attributeOntology} where key = ${dup}`);
      });
      repointed += prodRows.length;
      mergedKeys++;
    }
  }
  console.log(`✓ злито ключів: ${mergedKeys}; перепривʼязано атрибутів у ${affected.size} товар(ах)${DRY ? " (DRY)" : ""}`);

  // ── Крок 2: свіжа ревізія кожного зачепленого товару ─────────────────────
  const toReindex: { productId: string; revisionId: string }[] = [];
  if (!DRY && affected.size) {
    await db.transaction(async (tx) => {
      for (const pid of affected) {
        const [prod] = await tx.select().from(products).where(eq(products.id, pid)).limit(1);
        if (!prod || prod.status !== "active") continue;
        const categoryPath = (prod.categoryPath as string[]) ?? [];
        let media: { type: string; url: string }[] = [];
        if (prod.currentRevisionId) {
          const [rev] = await tx
            .select({ snapshot: productRevisions.snapshot })
            .from(productRevisions)
            .where(eq(productRevisions.id, prod.currentRevisionId))
            .limit(1);
          const snapMedia = (rev?.snapshot as { media?: { type: string; url: string }[] } | undefined)?.media;
          if (Array.isArray(snapMedia)) media = snapMedia;
        }
        const revisionId = await refreshCanonical(tx, pid, categoryPath, media);
        toReindex.push({ productId: pid, revisionId });
      }
    });
    console.log(`✓ створено ${toReindex.length} нових ревізій`);
  }

  // ── Крок 3: product.updated → indexer переіндексує ───────────────────────
  if (!DRY && toReindex.length) {
    const bus = await EventBus.connect();
    for (const r of toReindex) {
      await bus
        .publish(EventSubjects.ProductUpdated, {
          id: `ontapply-${r.revisionId}`,
          subject: EventSubjects.ProductUpdated,
          traceId: `ontapply-${r.productId}`,
          occurredAt: new Date().toISOString(),
          payload: { productId: r.productId, revisionId: r.revisionId },
        })
        .catch(() => void 0);
    }
    await bus.drain();
    console.log(`✓ емітнуто product.updated для ${toReindex.length} товар(ів)`);
  }

  if (!DRY) {
    console.log("→ запусти scripts/renormalize.ts (unit-хінти target могли змінитись) і ПЕРЕЗАПУСТИ normalizer.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ontology-apply error:", e?.message ?? e);
  process.exit(1);
});
