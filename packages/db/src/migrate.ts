import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Застосовує згенеровані drizzle-kit міграції. Запуск: `pnpm db:migrate`. */
async function main() {
  const url = process.env.DATABASE_URL ?? "postgres://wiki:wiki@localhost:5432/wiki";
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./migrations" });
  await client.end();
  console.log("✓ migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
