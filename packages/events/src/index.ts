import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  JSONCodec,
  AckPolicy,
  DeliverPolicy,
} from "nats";
import {
  EventSchemas,
  EventSubjects,
  type EventSubject,
  type EventOf,
} from "@wiki/contracts/events";

/**
 * Тонкий типобезпечний шар над NATS JetStream.
 *  - publish валідує payload zod-схемою відповідної події;
 *  - subscribe віддає типізовану подію та ручний ack (at-least-once);
 *  - консюмери durable → відновлення з місця, consumer groups для масштабу.
 */

const codec = JSONCodec();

/** Один стрім на весь домен `wiki.>`. */
const STREAM = "WIKI";

export class EventBus {
  private constructor(
    private nc: NatsConnection,
    private js: JetStreamClient,
    private jsm: JetStreamManager,
  ) {}

  static async connect(url = process.env.NATS_URL ?? "nats://localhost:4222"): Promise<EventBus> {
    const nc = await connect({ servers: url, name: "wiki" });
    const jsm = await nc.jetstreamManager();
    // ідемпотентне створення стріму
    await jsm.streams
      .add({ name: STREAM, subjects: ["wiki.>"], max_age: 0 })
      .catch(() => jsm.streams.update(STREAM, { subjects: ["wiki.>"] } as never));
    return new EventBus(nc, nc.jetstream(), jsm);
  }

  /** Публікація з валідацією. Повертає seq у стрімі. */
  async publish<S extends EventSubject>(subject: S, event: EventOf<S>): Promise<number> {
    const parsed = EventSchemas[subject].parse(event);
    const ack = await this.js.publish(subject, codec.encode(parsed), {
      msgID: parsed.id, // де-дублікація на боці JetStream
    });
    return ack.seq;
  }

  /**
   * Durable-підписка на subject (можна wildcard, напр. `wiki.crawl.>`).
   * handler отримує вже валідовану подію; кидок → nak (повтор), успіх → ack.
   */
  async subscribe<S extends EventSubject>(
    subject: S,
    durable: string,
    handler: (event: EventOf<S>) => Promise<void>,
  ): Promise<void> {
    await this.jsm.consumers
      .add(STREAM, {
        durable_name: durable,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: 4, // 3 ретраї → DLQ-логіка на боці хендлера
      })
      .catch(() => void 0);

    const consumer = await this.js.consumers.get(STREAM, durable);
    const messages = await consumer.consume();
    void (async () => {
      for await (const m of messages) {
        try {
          const schema = EventSchemas[subject];
          const event = schema.parse(codec.decode(m.data)) as EventOf<S>;
          await handler(event);
          m.ack();
        } catch (err) {
          console.error(`[${durable}] handler error:`, err);
          m.nak(2000); // повтор через 2с
        }
      }
    })();
  }

  async drain(): Promise<void> {
    await this.nc.drain();
  }
}

export { EventSubjects };
export type { EventSubject, EventOf };
export { runOutboxRelay } from "./outbox-relay.js";
export type { OutboxStore, OutboxRow } from "./outbox-relay.js";
