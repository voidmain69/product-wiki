/**
 * Чистий парсер sitemap.xml (без I/O) — щоб логіку можна було юніт-тестувати без мережі.
 * Підтримує плоский `<urlset>` (з опційним `<lastmod>`) і `<sitemapindex>` (вкладені мапи).
 * Порядок збереження — як у файлі. Рекурсивне завантаження вкладених + .gz — у main.ts.
 */

export interface SitemapEntry {
  loc: string;
  /** ISO-дата останньої зміни (для пропуску незмінених при ре-дискавері), якщо є. */
  lastmod?: string;
}

export interface ParsedSitemap {
  /** Сторінкові URL (коли це `<urlset>`). */
  entries: SitemapEntry[];
  /** URL вкладених sitemap (коли це `<sitemapindex>`) — їх треба завантажити рекурсивно. */
  nested: string[];
}

const LOC = /<loc>\s*([^<]+?)\s*<\/loc>/i;
const LASTMOD = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i;

/** Декодує базові XML-сутності в тексті URL (&amp; тощо). */
function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

/**
 * Парсить sitemap. Якщо це index (`<sitemapindex>`) — повертає `nested` (URL вкладених мап),
 * `entries` порожній. Інакше збирає `<url>`-блоки як `entries` з loc(+lastmod); якщо блоків
 * `<url>` нема (мінімалістичні мапи з голими `<loc>`) — фолбек на всі `<loc>`.
 */
export function parseSitemapXml(xml: string): ParsedSitemap {
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const nested = extractBlocks(xml, "sitemap")
      .map((b) => b.match(LOC)?.[1])
      .filter((v): v is string => !!v)
      .map(decode);
    return { entries: [], nested };
  }

  const urlBlocks = extractBlocks(xml, "url");
  if (urlBlocks.length) {
    const entries: SitemapEntry[] = [];
    for (const b of urlBlocks) {
      const loc = b.match(LOC)?.[1];
      if (!loc) continue;
      const lastmod = b.match(LASTMOD)?.[1];
      entries.push(lastmod ? { loc: decode(loc), lastmod } : { loc: decode(loc) });
    }
    return { entries, nested: [] };
  }

  // фолбек: голі <loc> без обгортки <url>
  const bare = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decode(m[1]!));
  return { entries: bare.map((loc) => ({ loc })), nested: [] };
}
