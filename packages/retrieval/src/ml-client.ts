/**
 * Клієнт до ML-сервісу (services/ml, Python). У Фазі 1 — REST-обгортка;
 * у проді — gRPC (ML_GRPC_URL). BGE-M3 віддає dense + sparse за один прохід,
 * bge-reranker-v2-m3 — крос-мовний rerank.
 */
export interface DenseSparse {
  dense: number[];
  sparse: { indices: number[]; values: number[] };
}

export class MlClient {
  constructor(private baseUrl = process.env.ML_HTTP_URL ?? "http://localhost:8080") {}

  /** Ембединг батчу текстів (dense + sparse одночасно). */
  async embed(texts: string[]): Promise<DenseSparse[]> {
    const res = await fetch(`${this.baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    if (!res.ok) throw new Error(`ml/embed ${res.status}`);
    return (await res.json()) as DenseSparse[];
  }

  /** Rerank: повертає індекси docs у порядку релевантності + скор. */
  async rerank(query: string, docs: string[], topK: number): Promise<{ index: number; score: number }[]> {
    const res = await fetch(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, docs, top_k: topK }),
    });
    if (!res.ok) throw new Error(`ml/rerank ${res.status}`);
    return (await res.json()) as { index: number; score: number }[];
  }
}
