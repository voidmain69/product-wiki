import { eq } from "drizzle-orm";
import { createDb, productDrafts, attributeOntology, outbox } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import type { EventOf } from "@wiki/contracts/events";
import { normalizeValue } from "./units.js";

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

  console.log("normalizer: підписка на", EventSubjects.DraftExtracted);

  await bus.subscribe(
    EventSubjects.DraftExtracted,
    "normalizer",
    async (event: EventOf<typeof EventSubjects.DraftExtracted>) => {
      const { draftId } = event.payload;
      const [draft] = await db.select().from(productDrafts).where(eq(productDrafts.id, draftId)).limit(1);
      if (!draft) return;

      const rawAttrs = draft.attributesRaw as { key: string; value: string; unit?: string }[];

      await db.transaction(async (tx) => {
        const normalized: {
          rawKey: string;
          canonicalKey: string;
          value: number | string | boolean;
          unit: string | null;
          valueRaw: string;
        }[] = [];
        for (const a of rawAttrs) {
          const rawKey = a.key.trim();
          let canonicalKey = aliasIndex.get(rawKey.toLowerCase());
          if (!canonicalKey) {
            // Авто-провіжн онтології: невідома мітка виробника стає канонічним ключем
            // (модерація/злиття синонімів — TODO merge_queue). Без цього факт губиться:
            // resolver пропускає canonicalKey=null, а API робить INNER JOIN
            // product_attributes × attribute_ontology (мітка для показу).
            canonicalKey = slugKey(rawKey);
            await tx
              .insert(attributeOntology)
              .values({ key: canonicalKey, label: rawKey, dataType: "string", aliases: [rawKey] })
              .onConflictDoNothing();
            aliasIndex.set(rawKey.toLowerCase(), canonicalKey);
          }
          const { value, unit } = normalizeValue(a.value, a.unit);
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
