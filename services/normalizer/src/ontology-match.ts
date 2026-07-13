/**
 * Крос-мовне зведення міток атрибутів до наявних ключів онтології. Чиста логіка
 * (без I/O) — тестується з детермінованими векторами/скорами.
 *
 * ВАЖЛИВО (емпірично, BGE-M3 tei): самого dense-косинуса НЕ досить для крос-мовного
 * матчингу коротких міток — «тверді негативи» (розміри height/width/depth, life↔capacity)
 * лежать усередині розподілу справжніх синонімів (0.69–0.79), тож єдиний dense-поріг
 * або зливає різні атрибути, або втрачає синоніми. Рішення — ДВОСТУПЕНЕВО (як гібридний
 * retrieval проєкту): dense-шортліст кандидатів (recall) → rerank-гейт (precision).
 * Заміри: rerank чисто розділяє (негативи ≤0.34, синоніми med 0.998) → нуль хибних злиттів.
 */

/** Dense-поріг шортлісту кандидатів (recall-орієнтований, не фінальне рішення). */
export const ONTOLOGY_DENSE_FLOOR = Number(process.env.ONTOLOGY_DENSE_FLOOR ?? "0.65");
/** Rerank-поріг фінального прийняття (precision-гейт). */
export const ONTOLOGY_RERANK_THRESHOLD = Number(process.env.ONTOLOGY_RERANK_THRESHOLD ?? "0.5");
/** Скільки dense-кандидатів передавати в rerank. */
export const ONTOLOGY_SHORTLIST_K = Number(process.env.ONTOLOGY_SHORTLIST_K ?? "8");
/**
 * Dense-only поріг — консервативний фолбек, коли rerank недоступний. Високий (0.92),
 * щоб не робити хибних злиттів без rerank-гейта. Перекривається ONTOLOGY_SIM_THRESHOLD.
 */
export const ONTOLOGY_SIM_THRESHOLD = Number(process.env.ONTOLOGY_SIM_THRESHOLD ?? "0.92");
/** Нижня межа «near-miss» — кандидати в цьому вікні логуються для ручного рев'ю онтології. */
export const ONTOLOGY_NEAR_MISS = 0.85;

/** Запис індексу: канонічний ключ онтології, його мітка (docs для rerank) і L2-норм. вектор. */
export interface LabelVec {
  key: string;
  label: string;
  vec: number[];
}

/** L2-нормалізація (косинус = скалярний добуток нормалізованих). */
export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

/** Найближчий ключ онтології за косинусом, БЕЗ порога (для near-miss-логів). `vec` L2-норм. */
export function bestMatch(vec: number[], index: LabelVec[]): { key: string; sim: number } | null {
  let best: { key: string; sim: number } | null = null;
  for (const entry of index) {
    const sim = dot(vec, entry.vec);
    if (!best || sim > best.sim) best = { key: entry.key, sim };
  }
  return best;
}

/**
 * Топ-K кандидатів за косинусом із порогом-floor (dense-шортліст для rerank).
 * Сортовано за спаданням; `vec` L2-нормалізований.
 */
export function topCandidates(
  vec: number[],
  index: LabelVec[],
  k: number = ONTOLOGY_SHORTLIST_K,
  floor: number = ONTOLOGY_DENSE_FLOOR,
): { entry: LabelVec; sim: number }[] {
  const scored = index
    .map((entry) => ({ entry, sim: dot(vec, entry.vec) }))
    .filter((c) => c.sim >= floor)
    .sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k);
}

/**
 * Найкращий ключ онтології для вектора мітки (косинус). Повертає null, якщо
 * найкращий збіг нижче порога або індекс порожній. `vec` має бути L2-нормалізований.
 * Використовується як dense-only фолбек (без rerank) — з консервативним порогом.
 */
export function matchLabel(
  vec: number[],
  index: LabelVec[],
  threshold: number = ONTOLOGY_SIM_THRESHOLD,
): { key: string; sim: number } | null {
  const best = bestMatch(vec, index);
  return best && best.sim >= threshold ? best : null;
}
