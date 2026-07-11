import { createHash } from "node:crypto";
import type { Browser } from "playwright";
import type { EngineAdapter, FetchTask, ProbeData, FetchResult } from "../types.js";
import type { JsonCapture } from "@wiki/contracts";

/**
 * Найдорожчий адаптер: рендер у Playwright для SPA.
 * Додатково перехоплює XHR/GraphQL-відповіді (apiPayloads) — часто вони чистіші за DOM
 * і живлять ApiReplayAdapter/extractor рівня "api".
 * Браузер лінійно імпортується, щоб пакет лишався легким там, де headless не потрібен.
 */
export class HeadlessAdapter implements EngineAdapter {
  readonly type = "headless" as const;
  private browser: Browser | null = null;

  constructor(private opts: { poolSize?: number } = {}) {}

  async probe(_url: string, probe: ProbeData): Promise<number> {
    // headless — fallback: висока впевненість лише коли static-даних явно нема
    const empty = probe.htmlSample.replace(/<[^>]+>/g, "").trim().length < 200;
    return empty ? 0.8 : 0.3;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: true });
    return this.browser;
  }

  async fetch(task: FetchTask, _probe: ProbeData): Promise<FetchResult> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({ userAgent: task.userAgent });
    const page = await context.newPage();

    const captures: JsonCapture[] = [];
    page.on("response", async (resp) => {
      const ct = resp.headers()["content-type"] ?? "";
      if (ct.includes("application/json") || ct.includes("graphql")) {
        try {
          captures.push({
            requestUrl: resp.url(),
            method: resp.request().method(),
            status: resp.status(),
            body: await resp.json(),
          });
        } catch {
          /* не-JSON тіло — ігноруємо */
        }
      }
    });

    let httpStatus = 0;
    try {
      const nav = await page.goto(task.url, { waitUntil: "networkidle", timeout: 30_000 });
      httpStatus = nav?.status() ?? 0;
      const html = await page.content();
      const screenshot = await page.screenshot({ fullPage: false });
      const contentHash = createHash("sha256").update(html).digest("hex");

      return {
        snapshot: {
          url: task.url,
          sourceId: task.sourceId,
          engine: this.type,
          httpStatus,
          contentHash,
          htmlKey: null,
          apiPayloads: captures,
          screenshotKeys: [], // fetcher проставить після вивантаження
          fetchedAt: new Date().toISOString(),
        },
        htmlBody: html,
        screenshots: [{ key: "viewport.png", bytes: screenshot }],
      };
    } finally {
      await context.close();
    }
  }

  async dispose(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
