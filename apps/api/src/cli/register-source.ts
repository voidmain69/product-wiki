import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createDb, sources, outbox, closeDb } from "@wiki/db";
import { EventSubjects } from "@wiki/contracts";

/**
 * CLI реєстрації довіреного джерела (виробника) — точка входу пайплайна.
 * Транзакційно: рядок у `sources` + подія `source.registered` в `outbox`
 * (інваріант 2). Доставку в NATS робить services/outbox-relay; discovery
 * підхоплює подію і починає обхід.
 *
 * Використання:
 *   tsx src/cli/register-source.ts <path-to-source.json>
 *   (або з кореня: pnpm --filter @wiki/api register-source <path>)
 *
 * Формат source.json:
 *   {
 *     "name": "ExampleTech",
 *     "domains": ["example-manufacturer.com"],
 *     "entrypoints": ["https://example-manufacturer.com/sitemap.xml"],
 *     "urlPatterns": ["/products/[^/]+$"],
 *     "maxRps": 0.5,
 *     "recrawlIntervalDays": 30
 *   }
 */

const SourceInput = z.object({
  name: z.string().min(1),
  domains: z.array(z.string()).min(1),
  entrypoints: z.array(z.string().url()).min(1),
  urlPatterns: z.array(z.string()).min(1),
  maxRps: z.number().positive().default(0.5),
  recrawlIntervalDays: z.number().int().positive().default(30),
  engineHint: z.enum(["static", "headless", "api-replay", "document"]).optional(),
  lang: z.string().min(2).max(5).optional(), // ISO 639-1 мова джерела (напр. "en") — для не-укр сайтів
});

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Використання: tsx src/cli/register-source.ts <path-to-source.json>");
    process.exit(1);
  }

  const input = SourceInput.parse(JSON.parse(readFileSync(path, "utf8")));
  const db = createDb();
  const now = new Date();

  const sourceId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sources)
      .values({
        name: input.name,
        domains: input.domains,
        verification: {
          method: "manual",
          verifiedBy: "cli",
          verifiedAt: now.toISOString(),
        },
        crawlPolicy: {
          entrypoints: input.entrypoints,
          urlPatterns: input.urlPatterns,
          maxRps: input.maxRps,
          recrawlIntervalDays: input.recrawlIntervalDays,
          ...(input.engineHint ? { engineHint: input.engineHint } : {}),
          ...(input.lang ? { lang: input.lang } : {}),
        },
        status: "active",
      })
      .returning({ id: sources.id });

    const id = row!.id;
    const traceId = randomUUID();
    // подія в outbox у тій самій транзакції (доставить outbox-relay)
    await tx.insert(outbox).values({
      subject: EventSubjects.SourceRegistered,
      traceId,
      payload: {
        id: randomUUID(),
        subject: EventSubjects.SourceRegistered,
        traceId,
        occurredAt: now.toISOString(),
        payload: { sourceId: id },
      },
    });
    return id;
  });

  console.log(`✓ Джерело "${input.name}" зареєстровано: ${sourceId}`);
  console.log("  Подію source.registered покладено в outbox → discovery почне обхід.");
  await closeDb();
}

main().catch((err) => {
  console.error("register-source failed:", err);
  process.exit(1);
});
