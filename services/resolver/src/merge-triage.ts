/**
 * Автоматичний тріаж fuzzy-кандидатів merge_queue. Чиста детермінована політика: за
 * сигналами (конфлікт ідентифікаторів, конфліктні спільні атрибути, косинус ембедингів
 * назв) видає рішення approve|reject|human. Використовується scripts/merge-queue.ts
 * (команда `triage`), яка постачає сигнали з БД + реального BGE-M3.
 *
 * Мета — безпечно згорнути хвіст черги: авто-approve ЛИШЕ коли назви майже тотожні за
 * ембедингом І жоден спільний атрибут не суперечить; авто-reject коли товари явно різні
 * (різний непорожній MPN/GTIN або кілька конфліктних характеристик). Сумнівне — людині.
 * Пороги — env (калібрувати без зміни коду), консервативні за замовчуванням.
 */

/** Ідентифікатори товару для перевірки конфлікту. */
export interface Identifiers {
  mpn?: string | null;
  gtin?: string | null;
}

/** Атрибут у полегшеній формі (ключ + канонічне значення) для порівняння пари. */
export interface AttrLite {
  key: string;
  value: unknown;
}

export interface TriageSignals {
  /** Обидва мають непорожній MPN (або GTIN) і вони різні → це РІЗНІ товари. */
  identifierConflict: boolean;
  /** К-сть спільних attr_key з РІЗНИМИ канонічними значеннями. */
  conflictingAttrs: number;
  /** К-сть спільних attr_key з ОДНАКОВИМИ значеннями (сила збігу, для інформації). */
  agreeingAttrs: number;
  /** Косинус ембедингів назв [-1..1] (реальний BGE-M3 dense). */
  nameCosine: number;
}

export type TriageVerdict = "approve" | "reject" | "human";

export interface TriageResult {
  verdict: TriageVerdict;
  reason: string;
}

/** Косинус для авто-approve (назви ~тотожні). Крос-мовно НЕ калібрований — див. ризики плану. */
export const TRIAGE_APPROVE_COSINE = Number(process.env.TRIAGE_APPROVE_COSINE ?? "0.95");
/** Стільки конфліктних спільних атрибутів → авто-reject (різні товари). */
export const TRIAGE_REJECT_CONFLICTS = Number(process.env.TRIAGE_REJECT_CONFLICTS ?? "3");

/** Нормалізація ідентифікатора: trim + upper; порожнє/undefined → null. */
function normId(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toUpperCase();
  return s || null;
}

/**
 * Конфлікт ідентифікаторів: якщо в обох товарів заповнений MPN і вони РІЗНІ — конфлікт;
 * аналогічно для GTIN. Відсутній ідентифікатор в одного боку конфлікту НЕ дає (мовчання ≠
 * заперечення). Достатньо конфлікту за будь-яким із двох.
 */
export function identifierConflict(a: Identifiers, b: Identifiers): boolean {
  const aMpn = normId(a.mpn), bMpn = normId(b.mpn);
  if (aMpn && bMpn && aMpn !== bMpn) return true;
  const aGtin = normId(a.gtin), bGtin = normId(b.gtin);
  if (aGtin && bGtin && aGtin !== bGtin) return true;
  return false;
}

/** Канонічне порівняння двох значень атрибута: числа з ε, рядки trim+lower, решта — deep. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Порівнює спільні (за attr_key) атрибути двох товарів. Рахує, скільки збігається за
 * значенням і скільки суперечить. Ключі, наявні лише в одного, ігноруємо (комплементарність
 * — це причина зливати, не роз'єднувати).
 */
export function attrConflictStats(left: AttrLite[], right: AttrLite[]): { agreeing: number; conflicting: number } {
  const r = new Map<string, unknown>();
  for (const a of right) r.set(a.key, a.value);
  let agreeing = 0, conflicting = 0;
  for (const a of left) {
    if (!r.has(a.key)) continue;
    if (sameValue(a.value, r.get(a.key))) agreeing++;
    else conflicting++;
  }
  return { agreeing, conflicting };
}

/** Косинус двох dense-векторів (0, якщо будь-який нульовий/різної довжини). */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Політика тріажу. Порядок правил важливий: спершу тверді reject-сигнали (різні товари),
 * потім впевнений approve, інакше — людині.
 */
export function triageDecision(s: TriageSignals): TriageResult {
  if (s.identifierConflict) return { verdict: "reject", reason: "різні MPN/GTIN — це різні товари" };
  if (s.conflictingAttrs >= TRIAGE_REJECT_CONFLICTS)
    return { verdict: "reject", reason: `${s.conflictingAttrs} конфліктних атрибутів (≥${TRIAGE_REJECT_CONFLICTS})` };
  if (s.nameCosine >= TRIAGE_APPROVE_COSINE && s.conflictingAttrs === 0)
    return { verdict: "approve", reason: `назви ~тотожні (cos=${s.nameCosine.toFixed(3)}), 0 конфліктів` };
  return { verdict: "human", reason: `cos=${s.nameCosine.toFixed(3)}, конфліктів=${s.conflictingAttrs}, збігів=${s.agreeingAttrs}` };
}
