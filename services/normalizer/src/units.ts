/**
 * Нормалізація одиниць до SI + збереження оригіналу. Приклади:
 *   "2,5 кг" → { value: 2.5, unit: "kg" }
 *   "1400 Вт" → { value: 1400, unit: "W" }
 *   "5.5 lbs" → { value: 2.495, unit: "kg" }
 * Таблиця конвертацій — розширювана; невідома одиниця → залишаємо як string.
 */
export interface Normalized {
  value: number | string | boolean;
  unit: string | null;
}

const TO_SI: Record<string, { unit: string; factor: number }> = {
  kg: { unit: "kg", factor: 1 },
  кг: { unit: "kg", factor: 1 },
  g: { unit: "kg", factor: 0.001 },
  г: { unit: "kg", factor: 0.001 },
  lbs: { unit: "kg", factor: 0.453592 },
  w: { unit: "W", factor: 1 },
  вт: { unit: "W", factor: 1 },
  kw: { unit: "W", factor: 1000 },
  квт: { unit: "W", factor: 1000 },
  db: { unit: "dB", factor: 1 },
  дб: { unit: "dB", factor: 1 },
  mah: { unit: "mAh", factor: 1 },
  mm: { unit: "mm", factor: 1 },
  мм: { unit: "mm", factor: 1 },
  cm: { unit: "mm", factor: 10 },
  см: { unit: "mm", factor: 10 },
};

export function normalizeValue(raw: string, unitHint?: string): Normalized {
  const cleaned = raw.trim().replace(",", ".");
  const m = cleaned.match(/(-?\d+(?:\.\d+)?)\s*([a-zA-Zа-яА-Я]+)?/);
  if (!m) return { value: raw, unit: null };

  const num = Number(m[1]);
  const unitToken = (m[2] ?? unitHint ?? "").toLowerCase();
  const conv = TO_SI[unitToken];
  if (Number.isNaN(num)) return { value: raw, unit: null };
  if (!conv) return { value: num, unit: unitToken || null };
  return { value: Math.round(num * conv.factor * 1000) / 1000, unit: conv.unit };
}
