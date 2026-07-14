/**
 * Єдина політика зведення атрибутів канонічного товару для знімка ревізії (інваріант 5:
 * мультиджерельний provenance). Кілька офіційних джерел можуть дати те саме поле з різними
 * значеннями — беремо НАЙСВІЖІШЕ (за fetchedAt снапшота), зберігаючи по одному рядку на ключ,
 * і рахуємо конфлікти (сигнал якості → quality-report). Чиста, тестується без БД.
 *
 * Використовується і resolver-ом (нормальний ingest), і merge-core (злиття/reindex), щоб
 * політика конфліктів була ОДНА, а не розходилась між шляхами.
 */

export interface AttrRow {
  attrKey: string;
  valueCanonical: unknown;
  unitCanonical: string | null;
  valueRaw: string;
  sourceSnapshotId: string;
}

export interface SnapshotAttr {
  key: string;
  valueCanonical: unknown;
  unitCanonical: string | null;
  valueRaw: string;
}

export interface ResolvedAttrs {
  /** По одному (найсвіжішому) значенню на ключ. */
  attributes: SnapshotAttr[];
  /** Скільки ключів мали розбіжні значення між джерелами (розв'язано на користь свіжого). */
  conflicts: number;
}

const EPOCH = new Date(0);

/** Канонічне порівняння значень: числа з ε, рядки trim+lower, решта — структурно. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Зводить рядки атрибутів (кілька провенанс-рядків на ключ) до одного значення на ключ —
 * найсвіжіше за `fetchedAt` снапшота. Відсутня дата → epoch (найстаріше). Конфлікт —
 * коли для ключа є ≥2 рядки з РІЗНИМИ канонічними значеннями.
 */
export function resolveAttrs(rows: AttrRow[], fetchedAt: Map<string, Date>): ResolvedAttrs {
  const byKey = new Map<string, AttrRow>();
  const conflicting = new Set<string>();
  for (const a of rows) {
    const prev = byKey.get(a.attrKey);
    if (!prev) {
      byKey.set(a.attrKey, a);
      continue;
    }
    if (!sameValue(prev.valueCanonical, a.valueCanonical)) conflicting.add(a.attrKey);
    const prevAt = fetchedAt.get(prev.sourceSnapshotId) ?? EPOCH;
    const curAt = fetchedAt.get(a.sourceSnapshotId) ?? EPOCH;
    if (curAt > prevAt) byKey.set(a.attrKey, a);
  }
  return {
    attributes: [...byKey.values()].map((a) => ({
      key: a.attrKey,
      valueCanonical: a.valueCanonical,
      unitCanonical: a.unitCanonical,
      valueRaw: a.valueRaw,
    })),
    conflicts: conflicting.size,
  };
}
