import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

export * from "./schema.js";
export { schema };

let _client: ReturnType<typeof postgres> | null = null;

/** Єдина фабрика підключення для всіх сервісів. */
export function createDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  _client ??= postgres(connectionString, { max: 10, prepare: true });
  return drizzle(_client, { schema });
}

export type Database = ReturnType<typeof createDb>;

export async function closeDb() {
  await _client?.end();
  _client = null;
}
