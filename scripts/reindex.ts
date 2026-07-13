/**
 * Бекфіл індексації: переганяє всі канонічні товари з БД у Qdrant через РЕАЛЬНИЙ
 * пайплайн — публікує `product.updated` для кожного товару з його поточною
 * ревізією, а запущений indexer-воркер будує типізовані чанки, ембедить (ML) і
 * upsert-ить у Qdrant. Потрібен, коли товари вже в Postgres, але Qdrant
 * порожній/застарілий (full-ingest навмисно не піднімає indexer/ML).
 *
 * Ідемпотентно: indexer робить upsert за стабільним id чанка + deleteStale, тож
 * повторний прогін безпечний. traceId нової генерації — це операційний реіндекс,
 * не продовження вихідного ланцюга обходу.
 *
 * Запуск: pnpm tsx scripts/reindex.ts
 *   (окремо має працювати indexer: node --import tsx services/indexer/src/main.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDb, products } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";

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

async function main() {
  loadEnv();
  const db = createDb();
  const bus = await EventBus.connect();

  const all = await db
    .select({ productId: products.id, revisionId: products.currentRevisionId })
    .from(products);
  const rows = all.filter((r) => r.revisionId); // лише товари з поточною ревізією

  console.log(`• публікую product.updated для ${rows.length} товарів`);
  let n = 0;
  for (const r of rows) {
    if (!r.revisionId) continue;
    await bus.publish(EventSubjects.ProductUpdated, {
      id: randomUUID(),
      subject: EventSubjects.ProductUpdated,
      traceId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: { productId: r.productId, revisionId: r.revisionId },
    });
    if (++n % 100 === 0) console.log(`  … ${n}/${rows.length}`);
  }
  console.log(`✓ опубліковано ${n} подій. Indexer обробляє їх асинхронно (стеж за points_count у Qdrant).`);
  await bus.drain();
  process.exit(0);
}

main().catch((e) => {
  console.error("reindex error:", e?.message ?? e);
  process.exit(1);
});
