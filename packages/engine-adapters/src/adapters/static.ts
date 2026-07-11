import { createHash } from "node:crypto";
import { request } from "undici";
import type { EngineAdapter, FetchTask, ProbeData, FetchResult } from "../types.js";
import { detectEngine } from "../detector.js";

/** Найдешевший адаптер: звичайний HTTP GET. Підходить для server-rendered сторінок. */
export class StaticHttpAdapter implements EngineAdapter {
  readonly type = "static" as const;

  async probe(_url: string, probe: ProbeData): Promise<number> {
    const hint = detectEngine(probe);
    return hint.engine === "static" ? hint.confidence : 0.2;
  }

  async fetch(task: FetchTask, _probe: ProbeData): Promise<FetchResult> {
    const res = await request(task.url, {
      method: "GET",
      headers: { "user-agent": task.userAgent, accept: "text/html,application/xhtml+xml" },
      maxRedirections: 5,
    });
    const html = await res.body.text();
    const contentHash = createHash("sha256").update(html).digest("hex");

    return {
      snapshot: {
        url: task.url,
        sourceId: task.sourceId,
        engine: this.type,
        httpStatus: res.statusCode,
        contentHash,
        htmlKey: null, // проставить fetcher після вивантаження в object storage
        apiPayloads: [],
        screenshotKeys: [],
        fetchedAt: new Date().toISOString(),
      },
      htmlBody: html,
      screenshots: [],
    };
  }
}
