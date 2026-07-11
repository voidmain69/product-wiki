import { z } from "zod";
import { Id, IsoDateTime } from "./common.js";

/**
 * Каталог подій шини (NATS JetStream). Subject-и ієрархічні: `wiki.<domain>.<event>`.
 * Кожна подія несе `id` (ідемпотентність), `traceId` (наскрізний трейсинг),
 * `occurredAt` і `payload`. Консюмери мають бути ідемпотентними (at-least-once).
 */

export const EventSubjects = {
  SourceRegistered: "wiki.source.registered",
  UrlDiscovered: "wiki.crawl.url_discovered",
  PageFetched: "wiki.crawl.page_fetched",
  PageUnchanged: "wiki.crawl.page_unchanged",
  DraftExtracted: "wiki.process.draft_extracted",
  DraftNormalized: "wiki.process.draft_normalized",
  ProductUpdated: "wiki.process.product_updated",
  ProductIndexed: "wiki.index.product_indexed",
  StageFailed: "wiki.dlq.stage_failed",
} as const;

export type EventSubject = (typeof EventSubjects)[keyof typeof EventSubjects];

/** Обгортка будь-якої події. */
const envelope = <T extends z.ZodTypeAny>(subject: EventSubject, payload: T) =>
  z.object({
    id: Id, // ідемпотентність
    subject: z.literal(subject),
    traceId: Id, // народжується в url.discovered, живе до product.indexed
    occurredAt: IsoDateTime,
    payload,
  });

/* ── Payload-и ─────────────────────────────────────────────────────────── */

export const SourceRegistered = envelope(
  EventSubjects.SourceRegistered,
  z.object({ sourceId: Id }),
);

export const UrlDiscovered = envelope(
  EventSubjects.UrlDiscovered,
  z.object({
    sourceId: Id,
    url: z.string().url(),
    priority: z.number().int().default(0), // вищий = раніше (нове/популярне)
  }),
);

export const PageFetched = envelope(
  EventSubjects.PageFetched,
  z.object({ sourceId: Id, snapshotRef: z.string(), url: z.string().url() }),
);

export const PageUnchanged = envelope(
  EventSubjects.PageUnchanged,
  z.object({ sourceId: Id, url: z.string().url(), contentHash: z.string() }),
);

export const DraftExtracted = envelope(
  EventSubjects.DraftExtracted,
  z.object({ sourceId: Id, snapshotRef: z.string(), draftId: Id }),
);

export const DraftNormalized = envelope(
  EventSubjects.DraftNormalized,
  z.object({ draftId: Id }),
);

export const ProductUpdated = envelope(
  EventSubjects.ProductUpdated,
  z.object({ productId: Id, revisionId: Id }),
);

export const ProductIndexed = envelope(
  EventSubjects.ProductIndexed,
  z.object({ productId: Id, revisionId: Id, chunkCount: z.number().int() }),
);

export const StageFailed = envelope(
  EventSubjects.StageFailed,
  z.object({
    failedSubject: z.string(),
    reason: z.string(),
    context: z.record(z.unknown()),
    attempts: z.number().int(),
  }),
);

/** Discriminated union усіх подій — для типобезпечного роутингу. */
export const AnyEvent = z.discriminatedUnion("subject", [
  SourceRegistered,
  UrlDiscovered,
  PageFetched,
  PageUnchanged,
  DraftExtracted,
  DraftNormalized,
  ProductUpdated,
  ProductIndexed,
  StageFailed,
]);
export type AnyEvent = z.infer<typeof AnyEvent>;

/** Мапа subject → schema, зручно для валідації в typed-клієнті. */
export const EventSchemas = {
  [EventSubjects.SourceRegistered]: SourceRegistered,
  [EventSubjects.UrlDiscovered]: UrlDiscovered,
  [EventSubjects.PageFetched]: PageFetched,
  [EventSubjects.PageUnchanged]: PageUnchanged,
  [EventSubjects.DraftExtracted]: DraftExtracted,
  [EventSubjects.DraftNormalized]: DraftNormalized,
  [EventSubjects.ProductUpdated]: ProductUpdated,
  [EventSubjects.ProductIndexed]: ProductIndexed,
  [EventSubjects.StageFailed]: StageFailed,
} as const;

export type EventOf<S extends EventSubject> = z.infer<(typeof EventSchemas)[S]>;
