"""ML inference: BGE-M3 (dense+sparse) embeddings та bge-reranker-v2-m3.

Тримає моделі в пам'яті, батчить запити. У Фазі 1 — HTTP; у проді додається gRPC
(ML_GRPC_URL) і скейл на GPU-ноди окремо від решти воркерів.
Мультимовність (укр/англ) — з коробки, тому вектори працюють крос-мовно без перекладу.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    from FlagEmbedding import BGEM3FlagModel, FlagReranker

    _state["embedder"] = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True)
    _state["reranker"] = FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True)
    yield
    _state.clear()


app = FastAPI(lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str]


class RerankRequest(BaseModel):
    query: str
    docs: list[str]
    top_k: int = 8


@app.get("/health")
def health() -> dict:
    return {"ok": True, "models_loaded": bool(_state)}


@app.post("/embed")
def embed(req: EmbedRequest) -> list[dict]:
    """Повертає dense + sparse (lexical weights) за один прохід."""
    out = _state["embedder"].encode(
        req.texts, return_dense=True, return_sparse=True, return_colbert_vecs=False
    )
    result = []
    for dense, lw in zip(out["dense_vecs"], out["lexical_weights"]):
        indices = [int(k) for k in lw.keys()]
        values = [float(v) for v in lw.values()]
        result.append(
            {"dense": dense.tolist(), "sparse": {"indices": indices, "values": values}}
        )
    return result


@app.post("/rerank")
def rerank(req: RerankRequest) -> list[dict]:
    """Крос-мовний rerank: індекси docs у порядку релевантності + скор."""
    pairs = [[req.query, d] for d in req.docs]
    scores = _state["reranker"].compute_score(pairs, normalize=True)
    if not isinstance(scores, list):
        scores = [scores]
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[: req.top_k]
    return [{"index": i, "score": float(s)} for i, s in ranked]
