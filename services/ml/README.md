# services/ml — Embedding + Rerank

Python-сервіс інференсу. Тримає моделі в пам'яті, віддає HTTP (Фаза 1) / gRPC (прод).

- **Embedding**: `BAAI/bge-m3` — мультимовна (укр/англ), dense + sparse за один прохід.
- **Rerank**: `BAAI/bge-reranker-v2-m3` — крос-мовний.

## Режими

- **prod (дефолт)** — реальні BGE-M3 + reranker (потребує torch/ваг, ~2-4 ГБ).
- **dev (`ML_DEV_MODE=1`)** — детерміновані ЛЕКСИЧНІ ембединги на numpy, без torch і
  без завантаження ваг: sparse = хешований TF (реальний лексичний матч), dense =
  стабільний bag-of-words (1024-dim, як у прода). Для локального E2E/CI без GPU.

## Запуск

```bash
cd services/ml

# dev-режим (швидко, без важких моделей) — використовується у pnpm smoke:ingest
python -m venv .venv && ./.venv/Scripts/pip install -e .    # base deps: fastapi/uvicorn/numpy
ML_DEV_MODE=1 ./.venv/Scripts/python -m uvicorn app:app --port 8091

# prod-режим (реальні моделі; перший старт тягне ваги ~2-4 ГБ)
uv sync --extra prod          # або: pip install -e ".[prod]"
uv run uvicorn app:app --port 8091
```

> Порт 8080 на цій машині може бути зайнятий IIS — за замовчуванням у `.env`
> використовується `ML_HTTP_URL=http://localhost:8091`. На GPU: `CUDA_VISIBLE_DEVICES`.

## Ендпоінти

- `POST /embed  { texts: string[] }` → `[{ dense: number[], sparse: {indices,values} }]`
- `POST /rerank { query, docs[], top_k }` → `[{ index, score }]`
- `GET  /health`

Node-клієнт — `@wiki/retrieval` (`MlClient`), `ML_HTTP_URL=http://localhost:8080`.
