/**
 * Порівняння якості LLM для чат-відповідей: на СПІЛЬНОМУ retrieved-контексті кожна модель
 * робить (а) intent-класифікацію і (б) генерацію відповіді. Метрики: faithsfulness (числа),
 * евристика «ухиляння», латентність. Ізолює генерацію від retrieval (контекст один і той
 * самий), щоб порівнювати саме модель. Потребує піднятих ML (реальний BGE-M3) + ollama.
 *
 * Запуск: pnpm tsx scripts/model-compare.ts [model1,model2,...]
 *   деф. моделі: qwen2.5:7b-instruct,gemma4:e4b
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLLM, llmConfigFromEnv, buildAnswerMessages } from "@wiki/llm";
import { MlClient, QdrantIndex } from "@wiki/retrieval";
import type { RetrievedChunk } from "@wiki/contracts";
import { classifyIntent } from "../services/chat-orchestrator/src/intent.js";
import { scoreFaithfulness } from "../services/chat-orchestrator/src/faithfulness.js";

const ROOT = join(import.meta.dirname, "..");

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

const QUERIES = [
  "Яка частота оновлення, час відгуку і діагональ монітора ASUS VP327Q?",
  "Розкажи про монітор ASUS VP327Q",
  "Порадь монітор ASUS з діагоналлю понад 30 дюймів",
  "Яка роздільна здатність монітора ASUS ProArt PA328QV?",
  "Які порти для підключення має монітор ASUS VP327Q?",
  "Порадь монітор ASUS для роботи з кольором для дизайнера",
  "Розкажи про навушники Philips Fidelio",
  "Яка вага бездротової миші Logitech MX Master?",
  "Порадь тиху бездротову мишу Logitech",
  "Які функції захисту очей мають монітори ASUS?",
  "Що таке технологія Adaptive-Sync у моніторів ASUS?",
  "Розкажи про дитячий цифровий термометр Philips Avent",
  "Яка яскравість монітора ASUS ProArt PA32UCE?",
  "Порадь монітор ASUS з роздільною здатністю 4K UHD",
  "Які характеристики має монітор ASUS ProArt Display 6K PA32QCV?",
  "Скільки кнопок має ігрова миша Logitech?",
  "Порівняй монітори ASUS ProArt PA328QV та PA329CRV за роздільністю",
  "Яка діагональ і роздільна здатність монітора ASUS VP32UQ?",
];
const DEFLECT = /уточніть|не зрозумів|не вказано|яке (питання|саме)|будь ласка, уточ|уточни|не конкретизовано|не (було|була|зазначен)/i;

interface Stat {
  n: number;
  faith: number[];
  deflect: number;
  empty: number;
  lat: number[];
  badCite: number;
}

async function main() {
  loadEnv();
  const models = (process.argv[2] ?? "qwen2.5:7b-instruct,gemma4:e4b").split(",");
  const ml = new MlClient();
  const qdrant = new QdrantIndex(new MlClient());
  const stats = new Map<string, Stat>(models.map((m) => [m, { n: 0, faith: [], deflect: 0, empty: 0, lat: [], badCite: 0 }]));

  // Фаза 1: retrieval усіх запитів ОДИН раз (не залежить від моделі) → спільні контексти.
  console.log(`• retrieval ${QUERIES.length} запитів…`);
  const items: { q: string; messages: ReturnType<typeof buildAnswerMessages>; context: string; nchunks: number }[] = [];
  for (const q of QUERIES) {
    const candidates = await qdrant.search(q, {}, 50);
    const rr = await ml.rerank(q, candidates.map((c) => c.text), 8);
    const reranked = rr.map((r) => candidates[r.index]!).filter(Boolean);
    const seen = new Set<string>();
    const cite: RetrievedChunk[] = [];
    for (const c of reranked) {
      const u = c.sourceUrls[0] ?? "";
      if (seen.has(u)) continue;
      seen.add(u);
      cite.push(c);
    }
    items.push({ q, messages: buildAnswerMessages(q, cite), context: cite.map((c) => c.text).join("\n"), nchunks: cite.length });
  }

  // Фаза 2: модель-ЗОВНІ (кожна вантажиться у VRAM один раз), запит-всередині.
  for (const model of models) {
    const llm = createLLM({ ...llmConfigFromEnv(), model });
    console.log("\n" + "=".repeat(70) + `\nМОДЕЛЬ: ${model}\n`);
    for (const it of items) {
      let intentStr = "?";
      try {
        const ri = await classifyIntent(llm, it.q, []);
        intentStr = ri.intent;
      } catch (e) {
        intentStr = "ERR:" + (e as Error).message.slice(0, 20);
      }
      const t0 = Date.now();
      let ans = "";
      try {
        ans = await llm.generate(it.messages, { temperature: 0.2 });
      } catch (e) {
        ans = "ERR: " + (e as Error).message;
      }
      const dtMs = Date.now() - t0;
      const f = scoreFaithfulness(ans, it.context);
      const deflected = DEFLECT.test(ans);
      const empty = ans.trim().length === 0;
      const badCite = /\[n\]/.test(ans);
      const st = stats.get(model)!;
      st.n++;
      st.faith.push(f.score);
      st.lat.push(dtMs);
      if (deflected) st.deflect++;
      if (empty) st.empty++;
      if (badCite) st.badCite++;
      const flags = [empty ? "ПОРОЖНЬО" : "", deflected ? "УХИЛЯННЯ" : "", badCite ? "[n]" : ""].filter(Boolean).join(",") || "ok";
      console.log(
        `  ${intentStr.padEnd(10)} ${(dtMs / 1000).toFixed(1).padStart(4)}s f=${(f.score * 100).toFixed(0).padStart(3)}% ${flags.padEnd(9)} | ${it.q.slice(0, 42).padEnd(42)} → ${ans.trim().slice(0, 70).replace(/\n/g, " ")}`,
      );
    }
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log("\n" + "=".repeat(70));
  console.log(`ПІДСУМОК по ${QUERIES.length} запитах:\n`);
  console.log("модель".padEnd(24) + "avg_faith  ухиляння  порожні  [n]-cite  avg_lat");
  for (const [model, s] of stats) {
    console.log(
      model.padEnd(24) +
        `${(avg(s.faith) * 100).toFixed(1)}%`.padEnd(11) +
        `${s.deflect}/${s.n}`.padEnd(10) +
        `${s.empty}/${s.n}`.padEnd(9) +
        `${s.badCite}/${s.n}`.padEnd(10) +
        `${(avg(s.lat) / 1000).toFixed(1)}s`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("model-compare error:", e?.message ?? e);
  process.exit(1);
});
