import { createDb, closeDb } from "./index.js";
import { sources, attributeOntology, categories } from "./schema.js";

/**
 * Мінімальний seed для dev: одне довірене джерело + базова онтологія/таксономія.
 * Запуск: `pnpm db:seed`.
 */
async function main() {
  const db = createDb();

  await db
    .insert(categories)
    .values({
      slug: "robot-vacuums",
      name: "Роботи-пилососи",
      path: ["Побутова техніка", "Пилососи", "Роботи-пилососи"],
    })
    .onConflictDoNothing();

  await db
    .insert(attributeOntology)
    .values([
      {
        key: "weight_net",
        label: "Вага нетто",
        dataType: "number",
        unitCanonical: "kg",
        aliases: ["вага", "weight", "net weight", "маса"],
      },
      {
        key: "power_w",
        label: "Потужність",
        dataType: "number",
        unitCanonical: "W",
        aliases: ["потужність", "power", "wattage"],
      },
      {
        key: "noise_db",
        label: "Рівень шуму",
        dataType: "number",
        unitCanonical: "dB",
        aliases: ["шум", "noise", "sound level"],
      },
      {
        key: "battery_mah",
        label: "Ємність акумулятора",
        dataType: "number",
        unitCanonical: "mAh",
        aliases: ["акумулятор", "battery", "battery capacity"],
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(sources)
    .values({
      name: "Example Manufacturer",
      domains: ["example-manufacturer.com"],
      verification: {
        method: "manual",
        verifiedBy: "seed",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      crawlPolicy: {
        entrypoints: ["https://example-manufacturer.com/sitemap.xml"],
        urlPatterns: ["/products/[^/]+$"],
        maxRps: 0.5,
        recrawlIntervalDays: 30,
      },
      status: "active",
    })
    .onConflictDoNothing();

  console.log("✓ seed complete");
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
