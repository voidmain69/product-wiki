/**
 * Класифікатор товарної сторінки (чистий, без I/O) для каталожного BFS: коли URL не
 * збігся з urlPatterns джерела, вирішуємо за розміткою, чи це сторінка товару. Спираємось
 * ЛИШЕ на структуровані маркери (JSON-LD / microdata / OpenGraph) — вони точні й
 * крос-вендорні. Раніше тут був ASUS-специфічний хардкод (rowTableTitle/PDTechSpec):
 * прибрано, бо давав хибні спрацювання й не переносився на інші сайти.
 *
 * Пріоритет — ТОЧНІСТЬ: хибнопозитив = категорійна сторінка піде в екстрактор і породить
 * сміттєвий draft. Тому спекуляція за «таблицею характеристик» свідомо не включена.
 */

/** JSON-LD `"@type":"Product"` (в т.ч. у масиві типів). */
export function hasJsonLdProduct(html: string): boolean {
  return /"@type"\s*:\s*(?:\[[^\]]*)?["']Product["']/i.test(html);
}

/** Microdata `itemtype="https://schema.org/Product"`. */
export function hasMicrodataProduct(html: string): boolean {
  return /itemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/i.test(html);
}

/** OpenGraph `og:type` = product (покриває `product`, `product.item`). Порядок атрибутів довільний. */
export function hasOgProduct(html: string): boolean {
  return (
    /<meta[^>]+property=["']og:type["'][^>]+content=["']product(?:\.[a-z]+)?["']/i.test(html) ||
    /<meta[^>]+content=["']product(?:\.[a-z]+)?["'][^>]+property=["']og:type["']/i.test(html)
  );
}

/** Сторінка товару, якщо є будь-який зі структурованих маркерів товару. */
export function isProductPage(html: string): boolean {
  return hasJsonLdProduct(html) || hasMicrodataProduct(html) || hasOgProduct(html);
}
