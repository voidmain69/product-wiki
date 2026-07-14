/**
 * Чисті хелпери розбору параметрів аналітики попиту (окремо від роуту — для юніт-тестів).
 */

export interface DemandParams {
  days: number;
  limit: number;
}

export const DEMAND_DAYS_DEFAULT = 30;
export const DEMAND_LIMIT_DEFAULT = 20;

/** Розбір `?days=&limit=` із дефолтами й клампінгом (days 1..365, limit 1..100). */
export function parseDemandParams(query: Record<string, unknown>): DemandParams {
  return {
    days: clampInt(query.days, DEMAND_DAYS_DEFAULT, 1, 365),
    limit: clampInt(query.limit, DEMAND_LIMIT_DEFAULT, 1, 100),
  };
}

/** Частка no_results у [0..1] (0, якщо запитів немає). */
export function noResultsShare(noResultsTotal: number, total: number): number {
  return total > 0 ? noResultsTotal / total : 0;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
