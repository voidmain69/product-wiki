import { httpGet } from "./http.js";
import type { EngineAdapter, FetchTask, ProbeData, FetchResult } from "./types.js";
import { StaticHttpAdapter } from "./adapters/static.js";
import { HeadlessAdapter } from "./adapters/headless.js";
import { PhilipsPrxAdapter } from "./adapters/philips-prx.js";

/**
 * Реєстр адаптерів + оркестрація вибору:
 *  1) дешевий probe (перші 64KB), 2) кожен адаптер оцінює свою придатність,
 *  3) виграє max(confidence). Результат детекції кешується per-source ззовні.
 */
export class AdapterRegistry {
  private adapters: EngineAdapter[];

  constructor(adapters?: EngineAdapter[]) {
    // порядок реєстрації неважливий — вибір за probe() (Philips віддає 0.97 лише на
    // власних товарних URL, тож не перехоплює інші джерела)
    this.adapters = adapters ?? [new StaticHttpAdapter(), new HeadlessAdapter(), new PhilipsPrxAdapter()];
  }

  register(adapter: EngineAdapter): void {
    this.adapters.push(adapter);
  }

  /** Дешеве зондування: GET перших ~64KB без рендеру. */
  async probeUrl(url: string, userAgent: string): Promise<ProbeData> {
    const res = await httpGet(url, userAgent);
    const buf = await res.body.arrayBuffer();
    const sample = new TextDecoder().decode(buf.slice(0, 64 * 1024));
    return {
      status: res.statusCode,
      contentType: String(res.headers["content-type"] ?? ""),
      headers: Object.fromEntries(
        Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
      ),
      htmlSample: sample,
    };
  }

  async pick(task: FetchTask): Promise<{ adapter: EngineAdapter; probe: ProbeData }> {
    const probe = await this.probeUrl(task.url, task.userAgent);

    // engineHint (закешований per-source) — короткий шлях без опитування всіх
    if (task.engineHint) {
      const hinted = this.adapters.find((a) => a.type === task.engineHint);
      if (hinted) return { adapter: hinted, probe };
    }

    const scored = await Promise.all(
      this.adapters.map(async (a) => ({ a, score: await a.probe(task.url, probe) })),
    );
    scored.sort((x, y) => y.score - x.score);
    const best = scored[0];
    if (!best) throw new Error("no adapters registered");
    return { adapter: best.a, probe };
  }

  async fetch(task: FetchTask): Promise<FetchResult & { engine: string }> {
    const { adapter, probe } = await this.pick(task);
    const result = await adapter.fetch(task, probe);
    return { ...result, engine: adapter.type };
  }

  async dispose(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.dispose?.()));
  }
}
