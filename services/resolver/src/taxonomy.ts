/**
 * Нормалізація бренду й категорій канонічної сутності (Етап D). Детермінована, курована.
 *
 * Бренд: суб-бренди зводимо до материнського (Avent/Fidelio/Evnia → Philips), щоб у фасеті
 * вендорів не з'являлись «псевдо-виробники». Лінія лишається в назві товару.
 *
 * Категорії: крихти виробника — сирі. Прибираємо продуктові ЛІНІЇ (ProArt/TUF Gaming… —
 * це серії ASUS, не категорії) і шум (Deals7), розбиваємо композити («Монітори, настільні
 * ПК» → два рівні) і дедуплікуємо. Мета — чистий, придатний для фільтра фасет категорій.
 */

/** Суб-бренд (lowercase) → материнський бренд. */
const SUB_BRANDS: Record<string, string> = {
  avent: "Philips",
  "philips avent": "Philips",
  fidelio: "Philips",
  "philips fidelio": "Philips",
  evnia: "Philips",
  "philips evnia": "Philips",
};

/** Сегменти категорій, що НЕ є категоріями: продуктові лінії (серії) + шум. */
const CATEGORY_DROP = new Set(
  [
    // ASUS-серії (це лінії, не категорії)
    "proart", "tuf gaming", "eye care", "zenscreen", "vivobook", "prime",
    "rog", "zenbook", "expertbook", "nuc",
    // шум / надто загальне
    "deals7", "для дому",
  ].map((s) => s.toLowerCase()),
);

/** Суб-бренд → материнський бренд (trim). Невідомий бренд — без змін. */
export function normalizeBrand(brand: string): string {
  const b = (brand ?? "").trim();
  return SUB_BRANDS[b.toLowerCase()] ?? b;
}

/**
 * Чистить categoryPath: розбиває композити (кома), прибирає серії/шум, тримає порядок,
 * дедуплікує, капіталізує перший символ кожного рівня. «/» НЕ роздільник («Аудіо/відео» —
 * одна категорія).
 */
export function normalizeCategoryPath(raw: string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const segRaw of raw ?? []) {
    for (const part of String(segRaw).split(/\s*,\s*/)) {
      const seg = capitalize(part.trim());
      if (!seg) continue;
      const k = seg.toLowerCase();
      if (CATEGORY_DROP.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(seg);
    }
  }
  return out;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
