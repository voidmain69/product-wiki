# services/ml — Embedding + Rerank

Python-сервіс інференсу. Тримає моделі в пам'яті, віддає HTTP (Фаза 1) / gRPC (прод).

- **Embedding**: `BAAI/bge-m3` — мультимовна (укр/англ), dense + sparse за один прохід.
- **Rerank**: `BAAI/bge-reranker-v2-m3` — крос-мовний.

## Запуск (dev)

```bash
cd services/ml
uv sync                      # або: pip install -e .
uv run uvicorn app:app --port 8080
```

Перший старт завантажує ваги моделей (~2-4 ГБ). На GPU виставити `CUDA_VISIBLE_DEVICES`.

## Ендпоінти

- `POST /embed  { texts: string[] }` → `[{ dense: number[], sparse: {indices,values} }]`
- `POST /rerank { query, docs[], top_k }` → `[{ index, score }]`
- `GET  /health`

Node-клієнт — `@wiki/retrieval` (`MlClient`), `ML_HTTP_URL=http://localhost:8080`.
