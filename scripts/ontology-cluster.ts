/**
 * BC1 (аналіз, БЕЗ мутацій): кластеризує ключі attribute_ontology за семантичною
 * близькістю міток (ембединги BGE-M3 через ML-сервіс) + збирає статистику значень.
 * Виводить пропозицію у scratchpad для рев'ю: (а) кластери синонімів-кандидатів,
 * (б) guess unit_canonical за міткою. Нічого не змінює.
 *
 * Запуск: pnpm tsx scripts/ontology-cluster.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, attributeOntology } from "@wiki/db";
import { MlClient } from "@wiki/retrieval";
import { guessUnit } from "../services/normalizer/src/units.js";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.ONTOLOGY_OUT ?? join(ROOT, "ontology-proposal.json");
const SIM_THRESHOLD = 0.92; // косинус для синонім-кандидатів

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

async function main() {
  loadEnv();
  const db = createDb();
  const ml = new MlClient();

  const keys = await db.select({ key: attributeOntology.key, label: attributeOntology.label, dataType: attributeOntology.dataType, unit: attributeOntology.unitCanonical }).from(attributeOntology);
  console.log(`• ${keys.length} ключів онтології`);

  // статистика значень по ключу
  const statRows = (await db.execute(sql`
    select attr_key,
           count(*)::int as n,
           count(*) filter (where jsonb_typeof(value_canonical) = 'number')::int as n_num,
           count(*) filter (where unit_canonical is not null)::int as n_unit,
           (array_agg(distinct left(value_raw, 40)))[1:3] as samples
    from product_attributes
    group by attr_key
  `)) as unknown as { attr_key: string; n: number; n_num: number; n_unit: number; samples: string[] }[];
  const stats = new Map(statRows.map((r) => [r.attr_key, r]));

  // ембединги міток (батчами)
  console.log("• ембеджу мітки (BGE-M3)…");
  const vecs: number[][] = [];
  const B = 32;
  for (let i = 0; i < keys.length; i += B) {
    const part = await ml.embed(keys.slice(i, i + B).map((k) => k.label));
    for (const p of part) vecs.push(normalize(p.dense));
    if ((i / B) % 5 === 0) process.stdout.write(`  …${Math.min(i + B, keys.length)}/${keys.length}\r`);
  }
  console.log(`\n• ${vecs.length} векторів`);

  // синонім-кластери через union-find за косинусом ≥ поріг (лише серед активно вживаних ключів)
  const used = keys.map((k, i) => ({ i, k, n: stats.get(k.key)?.n ?? 0 })).filter((x) => x.n > 0);
  const parent = new Map<number, number>(used.map((u) => [u.i, u.i]));
  const find = (x: number): number => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const union = (a: number, b: number) => parent.set(find(a), find(b));
  const edges: { a: string; b: string; sim: number }[] = [];
  for (let a = 0; a < used.length; a++) {
    for (let b = a + 1; b < used.length; b++) {
      const sim = dot(vecs[used[a]!.i]!, vecs[used[b]!.i]!);
      if (sim >= SIM_THRESHOLD) {
        union(used[a]!.i, used[b]!.i);
        if (sim >= 0.97) edges.push({ a: used[a]!.k.label, b: used[b]!.k.label, sim: round(sim) });
      }
    }
  }
  const clusters = new Map<number, string[]>();
  for (const u of used) {
    const r = find(u.i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(u.k.key);
  }
  const synClusters = [...clusters.values()]
    .filter((c) => c.length > 1)
    .map((c) => c.map((key) => ({ key, label: keys.find((k) => k.key === key)!.label, n: stats.get(key)?.n ?? 0 })).sort((a, b) => b.n - a.n))
    .sort((a, b) => b.length - a.length);

  // guess unit-хінтів для числових ключів без юніта
  const unitGuesses = keys
    .map((k) => {
      const st = stats.get(k.key);
      const guess = guessUnit(k.label);
      return { key: k.key, label: k.label, current: k.unit, guess, n: st?.n ?? 0, numRatio: st ? round(st.n_num / Math.max(1, st.n)) : 0, samples: st?.samples ?? [] };
    })
    .filter((g) => g.n > 0 && g.guess && !g.current && g.numRatio > 0.5)
    .sort((a, b) => b.n - a.n);

  writeFileSync(OUT, JSON.stringify({ synClusters, unitGuesses, strongEdges: edges.slice(0, 40) }, null, 2), "utf8");

  console.log(`\n=== СИНОНІМ-КЛАСТЕРИ (${synClusters.length} груп >1, sim≥${SIM_THRESHOLD}) ===`);
  for (const c of synClusters.slice(0, 20)) console.log(`  [${c.length}] ${c.map((x) => `${x.label}(${x.n})`).join("  ·  ")}`);
  console.log(`\n=== UNIT-ХІНТИ (${unitGuesses.length} числових ключів без юніта) — топ-20 ===`);
  for (const g of unitGuesses.slice(0, 20)) console.log(`  ${g.guess}\t${g.label} (n=${g.n}, num=${g.numRatio})  напр: ${g.samples.slice(0, 2).join(" | ")}`);
  console.log(`\n✓ повний звіт: ${OUT}`);
  process.exit(0);
}

function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

main().catch((e) => {
  console.error("ontology-cluster error:", e?.message ?? e);
  process.exit(1);
});
