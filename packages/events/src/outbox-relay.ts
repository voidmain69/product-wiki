import type { EventBus } from "./index.js";
import type { EventSubject, EventOf } from "@wiki/contracts/events";

/**
 * Transactional outbox relay: сервіси пишуть подію в таблицю `outbox` в тій самій
 * транзакції, що й доменні дані. Цей relay періодично забирає неопубліковані рядки
 * й доставляє у NATS, гарантуючи "записали в БД ⇒ подія точно вийде".
 *
 * `fetchUnpublished`/`markPublished` інжектуються, щоб пакет events не залежав від db.
 */
export interface OutboxRow {
  id: string;
  subject: string;
  payload: unknown;
  traceId: string;
}

export interface OutboxStore {
  fetchUnpublished(limit: number): Promise<OutboxRow[]>;
  markPublished(ids: string[]): Promise<void>;
}

export async function runOutboxRelay(
  bus: EventBus,
  store: OutboxStore,
  opts: { intervalMs?: number; batch?: number } = {},
): Promise<() => void> {
  const intervalMs = opts.intervalMs ?? 500;
  const batch = opts.batch ?? 100;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const rows = await store.fetchUnpublished(batch);
      const done: string[] = [];
      for (const row of rows) {
        await bus.publish(row.subject as EventSubject, row.payload as EventOf<EventSubject>);
        done.push(row.id);
      }
      if (done.length) await store.markPublished(done);
    } catch (err) {
      console.error("[outbox-relay]", err);
    } finally {
      if (!stopped) setTimeout(tick, intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
  };
}
