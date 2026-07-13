import type { ProductChunk, RetrievalFilters, RetrievedChunk } from "@wiki/contracts";
import type { MlClient } from "./ml-client.js";

/**
 * Обгортка над Qdrant REST. Гібридний пошук: named vectors dense+sparse в одній
 * точці, payload-фільтри (категорія/бренд/діапазони атрибутів). Reciprocal Rank
 * Fusion для об'єднання dense- і sparse-ранжувань.
 */
export const COLLECTION = "product_chunks";
const DENSE_DIM = 1024; // BGE-M3

export class QdrantIndex {
  constructor(
    private ml: MlClient,
    private baseUrl = process.env.QDRANT_URL ?? "http://localhost:6333",
  ) {}

  private async api(path: string, method: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`qdrant ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Ідемпотентне створення колекції з named-векторами. */
  async ensureCollection(): Promise<void> {
    const exists = await fetch(`${this.baseUrl}/collections/${COLLECTION}`)
      .then((r) => r.ok)
      .catch(() => false);
    if (exists) return;
    await this.api(`/collections/${COLLECTION}`, "PUT", {
      vectors: { dense: { size: DENSE_DIM, distance: "Cosine" } },
      sparse_vectors: { sparse: {} },
    });
    // payload-індекси для швидких фільтрів
    for (const field of ["productId", "brand", "categoryPath", "chunkType"]) {
      await this.api(`/collections/${COLLECTION}/index`, "PUT", {
        field_name: `payload.${field === "productId" ? "productId" : field}`,
        field_schema: "keyword",
      }).catch(() => void 0);
    }
  }

  /** Upsert чанків товару (реіндексація — delete старої ревізії робиться окремо). */
  async upsertChunks(chunks: ProductChunk[]): Promise<void> {
    if (!chunks.length) return;
    const vectors = await this.ml.embed(chunks.map((c) => c.text));
    const points = chunks.map((c, i) => ({
      id: hashPointId(c.id),
      vector: {
        dense: vectors[i]!.dense,
        sparse: { indices: vectors[i]!.sparse.indices, values: vectors[i]!.sparse.values },
      },
      payload: {
        chunkId: c.id,
        productId: c.productId,
        revisionId: c.revisionId,
        chunkType: c.chunkType,
        text: c.text,
        ...c.payload,
      },
    }));
    await this.api(`/collections/${COLLECTION}/points?wait=true`, "PUT", { points });
  }

  /** Видалити ВСІ чанки товару (напр. коли товар злито в дубль → merged_away). */
  async deleteProduct(productId: string): Promise<void> {
    await this.api(`/collections/${COLLECTION}/points/delete?wait=true`, "POST", {
      filter: { must: [{ key: "productId", match: { value: productId } }] },
    });
  }

  /** Видалити всі чанки товару зі старих ревізій. */
  async deleteStale(productId: string, keepRevisionId: string): Promise<void> {
    await this.api(`/collections/${COLLECTION}/points/delete?wait=true`, "POST", {
      filter: {
        must: [{ key: "productId", match: { value: productId } }],
        must_not: [{ key: "revisionId", match: { value: keepRevisionId } }],
      },
    });
  }

  /** Гібридний пошук з фільтрами → кандидати (до rerank). */
  async search(query: string, filters: RetrievalFilters, limit = 50): Promise<RetrievedChunk[]> {
    const [vec] = await this.ml.embed([query]);
    const qFilter = buildFilter(filters);

    // Qdrant Query API з prefetch (dense + sparse) і RRF-фьюзом
    const result = (await this.api(`/collections/${COLLECTION}/points/query`, "POST", {
      prefetch: [
        { query: vec!.dense, using: "dense", limit, filter: qFilter },
        {
          query: { indices: vec!.sparse.indices, values: vec!.sparse.values },
          using: "sparse",
          limit,
          filter: qFilter,
        },
      ],
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
    })) as { result: { points: QdrantPoint[] } };

    return result.result.points.map((p) => ({
      chunkId: String(p.payload.chunkId),
      productId: String(p.payload.productId),
      chunkType: String(p.payload.chunkType),
      text: String(p.payload.text),
      score: p.score ?? 0,
      sourceUrls: (p.payload.sourceUrls as string[]) ?? [],
    }));
  }
}

interface QdrantPoint {
  score?: number;
  payload: Record<string, unknown>;
}

function buildFilter(f: RetrievalFilters): Record<string, unknown> | undefined {
  const must: unknown[] = [];
  if (f.brand) must.push({ key: "brand", match: { value: f.brand } });
  if (f.productIds?.length) must.push({ key: "productId", match: { any: f.productIds } });
  if (f.categoryPath?.length)
    must.push({ key: "categoryPath", match: { any: f.categoryPath } });
  for (const [key, range] of Object.entries(f.attrRanges ?? {})) {
    must.push({ key: `attrs.${key}`, range: { gte: range.gte, lte: range.lte } });
  }
  return must.length ? { must } : undefined;
}

/** Qdrant вимагає uint64/uuid як id точки — беремо стабільний хеш рядка. */
function hashPointId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
