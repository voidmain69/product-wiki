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
      const normalized = rawAttrs.map((a) => {
        const canonicalKey = aliasIndex.get(a.key.toLowerCase().trim());
        const { value, unit } = normalizeValue(a.value, a.unit);
        return { rawKey: a.key, canonicalKey: canonicalKey ?? null, value, unit, valueRaw: a.value };
      });
      // невідомі ключі → TODO: insert у чергу пропозицій онтології

      await db.transaction(async (tx) => {
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

      console.log(`normalized draft ${draftId} (${normalized.length} attrs)`);
    },
  );

  process.on("SIGTERM", async () => {
    await bus.drain();
    process.exit(0);
  });
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
