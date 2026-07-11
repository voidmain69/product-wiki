#!/usr/bin/env node
/**
 * Скафолдер воркера за канонічним шаблоном проєкту — щоб нові сервіси не
 * дрейфували від конвенцій (ESM, durable = ім'я сервісу, SIGTERM, outbox).
 *
 * Використання:
 *   node scripts/new-service.mjs <name> "<опис>" [subject-in] [subject-out]
 *
 * Приклад:
 *   node scripts/new-service.mjs classifier "Класифікація категорій" \
 *     wiki.process.draft_normalized wiki.process.draft_classified
 *
 * subject-и мають існувати в packages/contracts/src/events.ts (перевіряється).
 * Після генерації: додай сервіс у знання (README карта), запусти pnpm check:arch.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const [name, description, subjectIn, subjectOut] = process.argv.slice(2);

if (!name || !description) {
  console.error('Використання: node scripts/new-service.mjs <name> "<опис>" [subject-in] [subject-out]');
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`✗ Ім'я "${name}" — лише kebab-case латиницею`);
  process.exit(1);
}

const dir = join(ROOT, "services", name);
if (existsSync(dir)) {
  console.error(`✗ services/${name} вже існує`);
  process.exit(1);
}

// Перевірка, що subject-и оголошені в contracts (правило "contracts first")
const eventsSrc = readFileSync(join(ROOT, "packages/contracts/src/events.ts"), "utf8");
for (const subj of [subjectIn, subjectOut].filter(Boolean)) {
  if (!eventsSrc.includes(`"${subj}"`)) {
    console.error(`✗ Subject "${subj}" не знайдено в packages/contracts/src/events.ts.`);
    console.error("  Спочатку додай подію в contracts (схема + EventSubjects + EventSchemas + AnyEvent).");
    process.exit(1);
  }
}

/** Знаходить ключ EventSubjects за значенням subject-а. */
function subjectKey(subj) {
  const m = eventsSrc.match(new RegExp(`(\\w+):\\s*"${subj.replaceAll(".", "\\.")}"`));
  return m?.[1] ?? null;
}

const inKey = subjectIn ? subjectKey(subjectIn) : null;
const outKey = subjectOut ? subjectKey(subjectOut) : null;

mkdirSync(join(dir, "src"), { recursive: true });

writeFileSync(
  join(dir, "package.json"),
  JSON.stringify(
    {
      name: `@wiki/${name}`,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "tsx watch src/main.ts",
        start: "tsx src/main.ts",
        typecheck: "tsc --noEmit",
        clean: "rimraf dist .turbo *.tsbuildinfo",
      },
      dependencies: {
        "@wiki/contracts": "workspace:*",
        "@wiki/db": "workspace:*",
        "@wiki/events": "workspace:*",
        "drizzle-orm": "^0.36.0",
      },
      devDependencies: {
        tsx: "^4.19.0",
        typescript: "^5.6.0",
        rimraf: "^6.0.1",
      },
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: { rootDir: "src", outDir: "dist", composite: false },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  ) + "\n",
);

const subscribeBlock = inKey
  ? `  console.log("${name}: підписка на", EventSubjects.${inKey});

  await bus.subscribe(
    EventSubjects.${inKey},
    "${name}", // durable = ім'я сервісу
    async (event: EventOf<typeof EventSubjects.${inKey}>) => {
      // TODO: обробка. Консюмер має бути ІДЕМПОТЕНТНИМ (at-least-once).
      // Якщо пишеш у Postgres і публікуєш подію — подія йде в outbox
      // У ТІЙ САМІЙ транзакції (див. services/resolver як зразок):
      //
      // await db.transaction(async (tx) => {
      //   /* доменні записи */
      //   await tx.insert(outbox).values({
      //     subject: EventSubjects.${outKey ?? "<OutEvent>"},
      //     traceId: event.traceId, // traceId протягується наскрізь
      //     payload: { id, subject: EventSubjects.${outKey ?? "<OutEvent>"}, traceId: event.traceId,
      //                occurredAt: new Date().toISOString(), payload: { /* ... */ } },
      //   });
      // });
      void event;
    },
  );`
  : `  // TODO: підписка на вхідну подію або періодичний tick
  void db;`;

writeFileSync(
  join(dir, "src", "main.ts"),
  `import { createDb, outbox } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import type { EventOf } from "@wiki/contracts/events";

/**
 * ${description}
 *
 * Вхід:  ${subjectIn ?? "—"}
 * Вихід: ${subjectOut ?? "—"}
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();

${subscribeBlock}

  process.on("SIGTERM", async () => {
    await bus.drain();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("${name} fatal:", err);
  process.exit(1);
});
`,
);

console.log(`✓ services/${name} створено:
  - package.json  (@wiki/${name}, workspace:* deps)
  - tsconfig.json (extends base)
  - src/main.ts   (durable "${name}", SIGTERM, outbox-шаблон)

Далі:
  1. Реалізуй обробник у src/main.ts
  2. pnpm install && pnpm check:arch
  3. Онови карту потоку подій у README.md`);
