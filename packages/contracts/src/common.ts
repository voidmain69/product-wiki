import { z } from "zod";

/** Спільні примітиви, що використовуються в подіях, сутностях і DTO. */

export const IsoDateTime = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** ULID/UUID-подібний ідентифікатор (валідуємо як непорожній рядок, щоб не прив'язуватись до формату). */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** Рушій, який використовує сайт виробника — визначає, яким адаптером тягнути контент. */
export const EngineType = z.enum([
  "static", // повний HTML з сервера (є JSON-LD / мікродані)
  "headless", // SPA (Next/Nuxt/Angular/React) — потрібен рендер у браузері
  "api-replay", // дані підтягуються XHR/GraphQL — повторюємо той самий виклик
  "document", // PDF-datasheet / інструкція
]);
export type EngineType = z.infer<typeof EngineType>;

/** Метод, яким витягнули структуровані дані зі сторінки (від найнадійнішого до fallback). */
export const ExtractionMethod = z.enum(["jsonld", "microdata", "api", "recipe", "llm"]);
export type ExtractionMethod = z.infer<typeof ExtractionMethod>;

/** Провенанс — прив'язка будь-якого факту до першоджерела. Наріжний камінь довіри. */
export const Provenance = z.object({
  sourceId: Id,
  snapshotRef: z.string().min(1), // ключ снапшота в object storage
  url: z.string().url(),
  fetchedAt: IsoDateTime,
});
export type Provenance = z.infer<typeof Provenance>;

/** Канонічне значення атрибута з одиницею в SI + збережений оригінал. */
export const AttributeValue = z.object({
  key: z.string(), // канонічний ключ з онтології, напр. "weight_net"
  valueCanonical: z.union([z.number(), z.string(), z.boolean()]),
  unitCanonical: z.string().nullable(), // "kg", "W", "mm"; null для нечислових
  valueRaw: z.string(), // як було на сайті: "2,5 кг"
  provenance: Provenance,
});
export type AttributeValue = z.infer<typeof AttributeValue>;
