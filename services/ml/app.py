"""ML inference: BGE-M3 (dense+sparse) embeddings та bge-reranker-v2-m3.

Тримає моделі в пам'яті, батчить запити. У Фазі 1 — HTTP; у проді додається gRPC
(ML_GRPC_URL) і скейл на GPU-ноди окремо від решти воркерів.
Мультимовність (укр/англ) — з коробки, тому вектори працюють крос-мовно без перекладу.

Режими:
  - продакшн (дефолт): реальний BGE-M3 + reranker (FlagEmbedding, потребує torch/ваг).
  - dev (ML_DEV_MODE=1): детерміновані ЛЕКСИЧНІ ембединги на numpy — без torch і без
    завантаження ваг. sparse = хешований TF (реальний лексичний матч), dense =
    стабільний bag-of-words-вектор. Для локального E2E/CI без GPU. Розмірність dense
    збігається з продом (1024), тож колекція Qdrant однакова в обох режимах.
  - tei (ML_TEI_MODE=1): ЛЕГКИЙ проксі на GPU-хост з HuggingFace TEI — реальні моделі
    без torch тут: dense BGE-M3 (TEI_DENSE_URL), sparse SPLADE (TEI_SPARSE_URL),
    rerank bge-reranker-v2-m3 (TEI_RERANK_URL). Реформатовує TEI-відповіді у наш API.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.request
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel

DEV_MODE = os.getenv("ML_DEV_MODE", "").lower() in ("1", "true", "yes")
TEI_MODE = os.getenv("ML_TEI_MODE", "").lower() in ("1", "true", "yes")
TEI_DENSE_URL = os.getenv("TEI_DENSE_URL", "").rstrip("/")
TEI_SPARSE_URL = os.getenv("TEI_SPARSE_URL", "").rstrip("/")
TEI_RERANK_URL = os.getenv("TEI_RERANK_URL", "").rstrip("/")
DENSE_DIM = 1024  # BGE-M3
SPARSE_SPACE = 100_000  # простір хешованих sparse-індексів у dev-режимі


# ── tei-режим: проксі на GPU-хост з HuggingFace TEI ─────────────────────────

def _tei_post(url: str, payload: dict) -> object:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _tei_embed(texts: list[str]) -> list[dict]:
    dense = _tei_post(f"{TEI_DENSE_URL}/embed", {"inputs": texts})  # [[float]*1024]
    sparse = _tei_post(f"{TEI_SPARSE_URL}/embed_sparse", {"inputs": texts})  # [[{index,value}]]
    out = []
    for i in range(len(texts)):
        sp = sparse[i]
        out.append({
            "dense": dense[i],
            "sparse": {"indices": [int(s["index"]) for s in sp], "values": [float(s["value"]) for s in sp]},
        })
    return out


def _tei_rerank(query: str, docs: list[str], top_k: int) -> list[dict]:
    # TEI /rerank повертає вже відсортований [{index, score}] — саме наш формат
    ranked = _tei_post(f"{TEI_RERANK_URL}/rerank", {"query": query, "texts": docs})
    return [{"index": int(r["index"]), "score": float(r["score"])} for r in ranked[:top_k]]

_state: dict = {}


# ── dev-режим: детерміновані лексичні ембединги (numpy) ──────────────────────

def _tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


def _stable_hash(token: str) -> int:
    return int.from_bytes(hashlib.md5(token.encode("utf-8")).digest()[:4], "little")


def _dev_embed(text: str) -> dict:
    toks = _tokens(text)
    # sparse: хешований токен → term frequency (справжній лексичний сигнал)
    tf: dict[int, float] = {}
    for t in toks:
        idx = _stable_hash(t) % SPARSE_SPACE
        tf[idx] = tf.get(idx, 0.0) + 1.0
    # dense: стабільний bag-of-words у DENSE_DIM, L2-нормалізований
    vec = np.zeros(DENSE_DIM, dtype=np.float32)
    for t in toks:
        vec[_stable_hash(t) % DENSE_DIM] += 1.0
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return {
        "dense": vec.tolist(),
        "sparse": {"indices": list(tf.keys()), "values": list(tf.values())},
    }


def _dev_rerank(query: str, docs: list[str], top_k: int) -> list[dict]:
    q = set(_tokens(query))
    scored = []
    for i, d in enumerate(docs):
        dt = set(_tokens(d))
        overlap = len(q & dt)
        union = len(q | dt) or 1
        scored.append((i, overlap / union))  # Jaccard
    scored.sort(key=lambda x: x[1], reverse=True)
    return [{"index": i, "score": float(s)} for i, s in scored[:top_k]]


# ── lifespan: у dev нічого не вантажимо ──────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    if DEV_MODE:
        _state["mode"] = "dev"
    elif TEI_MODE:
        _state["mode"] = "tei"  # моделі живуть на GPU-хості (TEI), тут нічого не вантажимо
    else:
        from FlagEmbedding import BGEM3FlagModel, FlagReranker

        _state["embedder"] = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True)
        _state["reranker"] = FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True)
        _state["mode"] = "prod"
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
    return {"ok": True, "mode": _state.get("mode", "starting")}


@app.post("/embed")
def embed(req: EmbedRequest) -> list[dict]:
    """Повертає dense + sparse (lexical weights) за один прохід."""
    if DEV_MODE:
        return [_dev_embed(t) for t in req.texts]
    if TEI_MODE:
        return _tei_embed(req.texts)

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
    """Rerank: індекси docs у порядку релевантності + скор."""
    if DEV_MODE:
        return _dev_rerank(req.query, req.docs, req.top_k)
    if TEI_MODE:
        return _tei_rerank(req.query, req.docs, req.top_k)

    pairs = [[req.query, d] for d in req.docs]
    scores = _state["reranker"].compute_score(pairs, normalize=True)
    if not isinstance(scores, list):
        scores = [scores]
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[: req.top_k]
    return [{"index": i, "score": float(s)} for i, s in ranked]
