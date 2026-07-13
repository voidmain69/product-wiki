import { eq, sql } from "drizzle-orm";
import { createDb, productDrafts, attributeOntology, outbox } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { MlClient } from "@wiki/retrieval";
import { createLLM } from "@wiki/llm";
import type { EventOf } from "@wiki/contracts/events";
import { normalizeValue, guessUnit } from "./units.js";
import { OntologyVecCache } from "./ontology-embed.js";
import { LabelTranslator } from "./label-translate.js";

/**
 * Normalizer-воркер: споживає `draft.extracted`, канонізує одиниці та мапить
 * "сирі" ключі атрибутів на онтологію (weight/вага/net weight → weight_net).
 * Невідомі ключі → чергу пропозицій онтології (модерація). Публікує `draft.normalized`.
 *
 * Скелет Фази 1: мапінг за aliases з таблиці attribute_ontology.
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();
  const ontology = await db.select().from(attributeOntology);
  const aliasIndex = buildAliasIndex(ontology);
  // unit-хінт за канонічним ключем (для «голих» чисел, де одиниця відома з ключа, не з рядка)
  const unitHint = new Map<string, string | null>(ontology.map((o) => [o.key, o.unitCanonical]));

  // Крос-мовне зведення невідомих міток до наявних ключів (двоступенево: dense-шортліст
  // BGE-M3 → rerank-гейт bge-reranker-v2-m3, обидва через @wiki/retrieval). Best-effort:
  // якщо ML недоступний — кеш вимикається, лишається авто-провіжн (як раніше).
  const ml = new MlClient();
  const ontologyCache = new OntologyVecCache(
    (texts) => ml.embed(texts).then((rs) => rs.map((r) => r.dense)),
    (query, docs) => ml.rerank(query, docs, docs.length),
  );
  await ontologyCache.init(ontology.map((o) => ({ key: o.key, label: o.label })));

  // Крос-мовна прокладка: мітку не-укр джерела перекладаємо українською ПЕРЕД матчингом
  // (dense/rerank не зводять EN↔UK). LLM-переклад лише для не-uk драфтів, кешовано;
  // помилка LLM → мітка лишається мовою джерела (best-effort).
  const llm = createLLM();
  const translator = new LabelTranslator(async (label) =>
    llm.generate([
      {
        role: "system",
        content:
          "Ти перекладаєш короткі мітки характеристик товарів з будь-якої мови українською — БУКВАЛЬНО й точно, зберігаючи технічний сенс. Відповідай ЛИШЕ перекладеною міткою: без лапок, пояснень, крапки. " +
          "Приклади: «Weight» → «Вага»; «Number of buttons» → «Кількість кнопок»; «Battery life» → «Час роботи від батареї»; «Sensor resolution» → «Роздільність сенсора».",
      },
      { role: "user", content: label },
    ]),
  );

  console.log("normalizer: підписка на", EventSubjects.DraftExtracted);

  await bus.subscribe(
    EventSubjects.DraftExtracted,
    "normalizer",
    async (event: EventOf<typeof EventSubjects.DraftExtracted>) => {
      const { draftId } = event.payload;
      const [draft] = await db.select().from(productDrafts).where(eq(productDrafts.id, draftId)).limit(1);
      if (!draft) return;

      const rawAttrs = draft.attributesRaw as { key: string; value: string; unit?: string }[];

      // Пре-пас (ДО транзакції): для кожної невідомої мітки — крос-мовний матч через ML.
      // Мережеві виклики поза транзакцією, щоб не тримати конекшн. Результат — рішення
      // per унікальний rawKey: known | alias(до наявного ключа) | provision(новий ключ).
      type Resolution =
        | { kind: "known"; key: string }
        | { kind: "alias"; key: string; rawKey: string }
        | { kind: "provision"; key: string; rawKey: string; label: string; hint: string | null };
      const resolutions = new Map<string, Resolution>();
      for (const a of rawAttrs) {
        const rawKey = a.key.trim();
        const lk = rawKey.toLowerCase();
        if (resolutions.has(lk)) continue;
        const known = aliasIndex.get(lk);
        if (known) {
          resolutions.set(lk, { kind: "known", key: known });
          continue;
        }
        // не-укр мітку зводимо до української ПЕРЕД матчингом; оригінал лишиться alias-ом.
        const canonLabel = await translator.toCanonical(rawKey, draft.lang);
        // якщо переклад уже відомий у aliasIndex — беремо ключ напряму (без ML-матчу)
        const knownByTr = canonLabel !== rawKey ? aliasIndex.get(canonLabel.toLowerCase()) : undefined;
        if (knownByTr) {
          resolutions.set(lk, { kind: "alias", key: knownByTr, rawKey });
          continue;
        }
        const matched = await ontologyCache.match(canonLabel);
        resolutions.set(
          lk,
          matched
            ? { kind: "alias", key: matched.key, rawKey }
            : { kind: "provision", key: slugKey(canonLabel), rawKey, label: canonLabel, hint: guessUnit(rawKey) ?? guessUnit(canonLabel) },
        );
      }

      const provisioned: { key: string; label: string }[] = [];
      await db.transaction(async (tx) => {
        const applied = new Set<string>(); // ключі, вже застосовані в цій транзакції (дубль-мітки)
        const normalized: {
          rawKey: string;
          canonicalKey: string;
          value: number | string | boolean;
          unit: string | null;
          valueRaw: string;
        }[] = [];
        for (const a of rawAttrs) {
          const rawKey = a.key.trim();
          const lk = rawKey.toLowerCase();
          const r = resolutions.get(lk)!;
          const canonicalKey = r.key;
          // Guard за rawKey (одиниця роботи): дублі тієї самої мітки в межах драфта
          // мутуємо раз; РІЗНІ мітки в один target — кожна додає свій alias.
          if (!applied.has(lk)) {
            applied.add(lk);
            if (r.kind === "alias") {
              // Ідемпотентний атомарний append мітки в aliases наявного ключа (без
              // read-modify-write гонки між подами / повторної доставки JetStream).
              await tx.execute(sql`
                update attribute_ontology
                set aliases = aliases || to_jsonb(${rawKey}::text)
                where key = ${r.key} and not aliases @> to_jsonb(${rawKey}::text)
              `);
              aliasIndex.set(rawKey.toLowerCase(), r.key);
            } else if (r.kind === "provision") {
              // Авто-провіжн: невідома мітка (нижче порога матчу / ML недоступний) стає
              // канонічним ключем. Канонічна мітка — УКРАЇНСЬКА (переклад), а оригінальна
              // мітка джерела (напр. EN) йде alias-ом, щоб майбутні інжести зводились сюди.
              // unit-хінт одразу з мітки (guessUnit) — щоб «голі» числа теж мали одиницю.
              const aliases = [...new Set([r.rawKey, r.label])];
              await tx
                .insert(attributeOntology)
                .values({ key: canonicalKey, label: r.label, dataType: "string", unitCanonical: r.hint, aliases })
                .onConflictDoNothing();
              aliasIndex.set(r.rawKey.toLowerCase(), canonicalKey);
              aliasIndex.set(r.label.toLowerCase(), canonicalKey);
              unitHint.set(canonicalKey, r.hint);
              provisioned.push({ key: canonicalKey, label: r.label });
            }
          }
          // одиниця з рядка має пріоритет; інакше — хінт ключа онтології
          const { value, unit } = normalizeValue(a.value, a.unit ?? unitHint.get(canonicalKey) ?? undefined);
          normalized.push({ rawKey, canonicalKey, value, unit, valueRaw: a.value });
        }

        await tx
          .update(productDrafts)
          .set({ normalized: true, attributesRaw: normalized })
          .where(eq(productDrafts.id, draftId));
        await tx.insert(outbox).values({
          subject: EventSubjects.DraftNormalized,
          traceId: event.traceId,
          payload: {
            id: `${draftId}-norm`, subject: EventSubjects.DraftNormalized, traceId: event.traceId,
            occurredAt: new Date().toISOString(), payload: { draftId },
          },
        });
      });

      // Best-effort: доембедити щойно провіжнені ключі в індекс (поза транзакцією), щоб
      // наступні мітки-синоніми в межах цієї ж сесії могли до них зматчитись.
      for (const p of provisioned) await ontologyCache.add(p.key, p.label);

      console.log(`normalized draft ${draftId} (${rawAttrs.length} attrs)`);
    },
  );

  process.on("SIGTERM", async () => {
    await bus.drain();
    process.exit(0);
  });
}

/** Стабільний ключ онтології з мітки виробника (кирилицю лишаємо — Postgres text PK). */
function slugKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  if (slug) return slug;
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return `attr_${h.toString(36)}`;
}

function buildAliasIndex(ontology: { key: string; aliases: string[] | null }[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const o of ontology) {
    idx.set(o.key.toLowerCase(), o.key);
    for (const alias of o.aliases ?? []) idx.set(alias.toLowerCase(), o.key);
  }
  return idx;
}

main().catch((err) => {
  console.error("normalizer fatal:", err);
  process.exit(1);
});
