import { isNull, asc, inArray } from "drizzle-orm";
import { createDb, outbox } from "@wiki/db";
import { EventBus, runOutboxRelay } from "@wiki/events";

/**
 * Єдиний relay-процес: доставляє неопубліковані рядки з таблиці `outbox` у NATS.
 * Гарантія "записали в БД ⇒ подія точно вийде" (transactional outbox pattern).
 * Пише в ту саму БД, куди сервіси кладуть події транзакційно з доменними даними.
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();

  const stop = await runOutboxRelay(
    bus,
    {
      async fetchUnpublished(limit) {
        const rows = await db
          .select()
          .from(outbox)
          .where(isNull(outbox.publishedAt))
          .orderBy(asc(outbox.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          subject: r.subject,
          payload: r.payload,
          traceId: r.traceId,
        }));
      },
      async markPublished(ids) {
        if (!ids.length) return;
        await db.update(outbox).set({ publishedAt: new Date() }).where(inArray(outbox.id, ids));
      },
    },
    { intervalMs: 500, batch: 100 },
  );

  console.log("outbox-relay: running (poll 500ms)");

  process.on("SIGTERM", async () => {
    stop();
    await bus.drain();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("outbox-relay fatal:", err);
  process.exit(1);
});
