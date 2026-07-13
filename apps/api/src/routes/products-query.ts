/**
 * Чисті хелпери розбору параметрів каталогу (навігація/фільтри/пагінація/сортування).
 * Винесені окремо від роутів, щоб покрити юніт-тестами без БД.
 */

export type SortKey = "updated" | "name" | "brand";
const SORTS: readonly SortKey[] = ["updated", "name", "brand"];

export interface ListParams {
  q?: string;
  brand?: string;
  category?: string;
  sort: SortKey;
  limit: number;
  page: number;
  offset: number;
}

export const LIST_LIMIT_DEFAULT = 24;
export const LIST_LIMIT_MAX = 60;

/** Розбір і нормалізація query-параметрів списку (з дефолтами й клампінгом). */
export function parseListParams(query: Record<string, unknown>): ListParams {
  const q = str(query.q);
  const brand = str(query.brand);
  const category = str(query.category);
  const sort = SORTS.includes(query.sort as SortKey) ? (query.sort as SortKey) : "updated";
  const limit = clampInt(query.limit, LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
  const page = clampInt(query.page, 1, 1, 100_000);
  const offset = (page - 1) * limit;
  return { q, brand, category, sort, limit, page, offset };
}

/** Кількість сторінок для total/limit (мінімум 1, щоб UI завжди мав валідний стан). */
export function totalPages(total: number, limit: number): number {
  if (limit <= 0) return 1;
  return Math.max(1, Math.ceil(total / limit));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
