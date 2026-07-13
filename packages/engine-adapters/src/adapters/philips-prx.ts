import { createHash } from "node:crypto";
import type { EngineAdapter, FetchTask, ProbeData, FetchResult } from "../types.js";
import { httpGet } from "../http.js";

/**
 * Philips PRX-адаптер (api-replay). Сторінка /c-p/<CTN>/<slug> — Next.js SSR:
 * name/brand/зображення лежать у JSON-LD, а теххарактеристики довантажуються
 * клієнтом окремим викликом PRX-API. Повторюємо той самий виклик (invariant 9:
 * новий рушій = новий адаптер): GET .../products/<CTN>.specification.
 *
 * Повертаємо HTML сторінки (для JSON-LD/крихт на рівні 1 каскаду) + сирий PRX-JSON
 * у apiPayloads (рівень 2 каскаду розбирає csChapter/csItem/csValue у пари атрибутів).
 * Ввічливість/rate-limit — на fetcher-і (два GET у межах одного домену).
 */
export class PhilipsPrxAdapter implements EngineAdapter {
  readonly type = "api-replay" as const;

  async probe(url: string, _probe: ProbeData): Promise<number> {
    // лише товарні сторінки Philips — інакше не перехоплюємо чужі джерела
    return isPhilipsProduct(url) ? 0.97 : 0;
  }

  async fetch(task: FetchTask, _probe: ProbeData): Promise<FetchResult> {
    const res = await httpGet(task.url, task.userAgent);
    const html = await res.body.text();

    const apiPayloads: FetchResult["snapshot"]["apiPayloads"] = [];
    const ctn = philipsCtn(task.url);
    if (ctn) {
      const specUrl = prxSpecUrl(ctn);
      try {
        const sres = await httpGet(specUrl, task.userAgent, "application/json");
        if (sres.statusCode === 200) {
          const body = await sres.body.json();
          apiPayloads.push({ requestUrl: specUrl, method: "GET", status: sres.statusCode, body });
        } else {
          await sres.body.dump(); // звільнити сокет за не-200
        }
      } catch {
        // спеки недоступні — не блокуємо товар: лишиться JSON-LD (name/brand/media)
      }
    }

    // contentHash має враховувати й PRX-пейлоад: інакше recrawl, де змінились лише
    // спеки (а HTML — ні), виглядав би незмінним (page.unchanged) і не переекстрактився б.
    const contentHash = createHash("sha256")
      .update(html)
      .update(JSON.stringify(apiPayloads))
      .digest("hex");

    return {
      snapshot: {
        url: task.url,
        sourceId: task.sourceId,
        engine: this.type,
        httpStatus: res.statusCode,
        contentHash,
        htmlKey: null, // проставить fetcher після вивантаження в object storage
        apiPayloads,
        screenshotKeys: [],
        fetchedAt: new Date().toISOString(),
      },
      htmlBody: html,
      screenshots: [],
    };
  }
}

/** Товарна сторінка Philips: https://www.philips.ua/c-p/<CTN>/<slug>. */
function isPhilipsProduct(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)philips\.ua$/i.test(u.hostname) && /^\/c-p\/[^/]+\/[^/]+$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** CTN із URL: /c-p/HR3660_55/avance-collection-blender → "HR3660_55". */
function philipsCtn(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/^\/c-p\/([^/]+)\//);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** PRX-ендпоінт теххарактеристик (формат сервера — див. 400-підказку API). */
function prxSpecUrl(ctn: string): string {
  return `https://www.philips.ua/prx/product/B2C/uk_UA/CONSUMER/products/${ctn}.specification`;
}
