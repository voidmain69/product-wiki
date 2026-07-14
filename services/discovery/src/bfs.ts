/**
 * Чиста логіка каталожного BFS (без I/O): дістати посилання зі сторінки й розкласти їх
 * на товарні (за urlPatterns) і каталожні (той самий хост, ще в межах глибини). Обхід
 * подієвий: фактичне завантаження робить ВВІЧЛИВИЙ fetcher (robots + rate-limit), тут
 * лише рішення, що ставити в чергу. Тестується без мережі.
 */

/** Абсолютні посилання зі сторінки (fragment відкидаємо), нормалізовані відносно base. */
export function extractLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      out.push(new URL(m[1]!, base).toString());
    } catch {
      /* невалідний href */
    }
  }
  return out;
}

/** Чи належить URL одному з доменів джерела (ігноруючи www.). */
export function sameHost(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    return domains.some((d) => host === d.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

export interface LinkRouting {
  /** Посилання, що збіглися з urlPatterns → сторінки товарів (у чергу як product). */
  products: string[];
  /** Той самий хост, не-товарні, depth < maxDepth → каталожні для подальшого обходу. */
  listings: string[];
}

/**
 * Розкладає посилання сторінки на product/listing. Товарні визначаємо за urlPatterns
 * (курований, точний сигнал); решту того ж хоста беремо як каталожні для обходу, доки
 * не вичерпано глибину. Дедуп у межах виклику. Зовнішні хости відкидаємо.
 */
export function routeLinks(
  html: string,
  base: string,
  patterns: RegExp[],
  domains: string[],
  depth: number,
  maxDepth: number,
): LinkRouting {
  const products = new Set<string>();
  const listings = new Set<string>();
  for (const link of extractLinks(html, base)) {
    if (!sameHost(link, domains)) continue;
    if (patterns.some((r) => r.test(link))) products.add(link);
    else if (depth < maxDepth) listings.add(link);
  }
  return { products: [...products], listings: [...listings] };
}
