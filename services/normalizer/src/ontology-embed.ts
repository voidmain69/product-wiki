/**
 * I/O-обгортка навколо чистої логіки матчингу: тримає in-memory індекс векторів міток
 * онтології, ембедить/ранжує нові мітки через ін'єктовані ML-функції (прод — MlClient з
 * @wiki/retrieval; тести — фейк). Уся мережа тут; помилки ML НЕ валять нормалізацію —
 * кеш деградує до вимкненого стану, і normalizer працює як раніше (авто-провіжн).
 *
 * Матчинг ДВОСТУПЕНЕВИЙ (див. ontology-match.ts): dense-шортліст → rerank-гейт. Без
 * rerank (не ін'єктовано) — консервативний dense-only фолбек. У ML_DEV_MODE лексичні
 * ембединги не досягнуть порогів — деградація «сама собою».
 */
import {
  bestMatch,
  l2normalize,
  matchLabel,
  topCandidates,
  ONTOLOGY_DENSE_FLOOR,
  ONTOLOGY_NEAR_MISS,
  ONTOLOGY_RERANK_THRESHOLD,
  ONTOLOGY_SHORTLIST_K,
  ONTOLOGY_SIM_THRESHOLD,
  type LabelVec,
} from "./ontology-match.js";

/** Ембед батчу текстів → dense-вектори (ще не нормалізовані). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;
/** Rerank: query проти docs → [{index, score}] (index у координатах docs). */
export type RerankFn = (query: string, docs: string[]) => Promise<{ index: number; score: number }[]>;

const BATCH = 32; // як у scripts/ontology-cluster.ts

export interface MatchResult {
  key: string;
  sim: number;
}

export interface CacheOpts {
  denseFloor?: number;
  rerankThreshold?: number;
  shortlistK?: number;
  denseOnlyThreshold?: number;
}

export class OntologyVecCache {
  private index: LabelVec[] = [];
  private byKey = new Set<string>();
  private disabled = false;
  private warned = false;
  private readonly denseFloor: number;
  private readonly rerankThreshold: number;
  private readonly shortlistK: number;
  private readonly denseOnlyThreshold: number;

  constructor(
    private embed: EmbedFn,
    private rerank: RerankFn | null = null,
    opts: CacheOpts = {},
  ) {
    this.denseFloor = opts.denseFloor ?? ONTOLOGY_DENSE_FLOOR;
    this.rerankThreshold = opts.rerankThreshold ?? ONTOLOGY_RERANK_THRESHOLD;
    this.shortlistK = opts.shortlistK ?? ONTOLOGY_SHORTLIST_K;
    this.denseOnlyThreshold = opts.denseOnlyThreshold ?? ONTOLOGY_SIM_THRESHOLD;
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  /** Ембедить усі наявні мітки онтології при старті. Помилка ML → вимкнення (best-effort). */
  async init(labels: { key: string; label: string }[]): Promise<void> {
    if (!labels.length) return;
    try {
      for (let i = 0; i < labels.length; i += BATCH) {
        const slice = labels.slice(i, i + BATCH);
        const vecs = await this.embed(slice.map((l) => l.label));
        vecs.forEach((v, j) => this.push(slice[j]!.key, slice[j]!.label, v));
      }
      console.log(`ontology-embed: індекс міток готовий (${this.index.length}, rerank=${this.rerank ? "on" : "off"})`);
    } catch (e) {
      this.disable(e);
    }
  }

  /**
   * Матч сирої мітки виробника до наявного ключа онтології (двоступенево). Повертає null,
   * якщо кеш вимкнено/порожній або жоден кандидат не пройшов гейт. Near-miss логуються
   * для ручного рев'ю. Ніколи не кидає.
   */
  async match(rawLabel: string): Promise<MatchResult | null> {
    if (this.disabled || !this.index.length) return null;
    try {
      const vecs = await this.embed([rawLabel]);
      const v = vecs[0];
      if (!v) return null;
      const norm = l2normalize(v);

      // Ступінь 1: dense-шортліст кандидатів (recall).
      const shortlist = topCandidates(norm, this.index, this.shortlistK, this.denseFloor);
      if (!shortlist.length) return null;

      // Ступінь 2: rerank-гейт (precision). Без rerank — консервативний dense-only фолбек.
      if (this.rerank) {
        const ranked = await this.rerank(rawLabel, shortlist.map((c) => c.entry.label));
        const top = ranked[0]; // TEI повертає відсортовано за score
        if (top && top.score >= this.rerankThreshold) {
          const cand = shortlist[top.index];
          if (cand) return { key: cand.entry.key, sim: top.score };
        }
        this.logNearMiss(rawLabel, norm);
        return null;
      }

      const matched = matchLabel(norm, shortlist.map((c) => c.entry), this.denseOnlyThreshold);
      if (matched) return matched;
      this.logNearMiss(rawLabel, norm);
      return null;
    } catch {
      return null; // best-effort: одна невдала мітка не валить весь драфт
    }
  }

  /** Інкрементально доембедити щойно створений ключ (після авто-провіжну). Best-effort. */
  async add(key: string, label: string): Promise<void> {
    if (this.disabled || this.byKey.has(key)) return;
    try {
      const vecs = await this.embed([label]);
      if (vecs[0]) this.push(key, label, vecs[0]);
    } catch {
      /* best-effort: наступний рестарт доембедить через init */
    }
  }

  private logNearMiss(rawLabel: string, norm: number[]): void {
    const best = bestMatch(norm, this.index);
    if (best && best.sim >= ONTOLOGY_NEAR_MISS) {
      console.log(`ontology near-miss: "${rawLabel}" ~ ${best.key} (cos=${best.sim.toFixed(3)})`);
    }
  }

  private push(key: string, label: string, vec: number[]): void {
    if (this.byKey.has(key)) return;
    this.byKey.add(key);
    this.index.push({ key, label, vec: l2normalize(vec) });
  }

  private disable(e: unknown): void {
    this.disabled = true;
    if (!this.warned) {
      this.warned = true;
      console.warn(
        `ontology-embed: ML недоступний — крос-мовний матчинг вимкнено, лишається авто-провіжн (${(e as Error)?.message ?? e})`,
      );
    }
  }
}
