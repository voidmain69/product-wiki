# Вікіпедія товарів

Некомерційний RAG-сервіс достовірної інформації про товари. Дані — **лише з офіційних
сайтів виробників**, кожна відповідь чату — з посиланням на першоджерело.

> Архітектурний документ: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Стек

TypeScript-монорепо (pnpm + Turborepo). Python — лише для ML-інференсу.
Postgres · NATS JetStream · Qdrant · MinIO · Redis · BGE-M3 · Next.js · Fastify.

## Структура

```
apps/       web (Next.js чат) · api (Fastify + SSE)
services/   discovery · scheduler · fetcher · extractor · normalizer ·
            resolver · indexer · chat-orchestrator(lib) · outbox-relay · ml(Python)
packages/   contracts · db · events · engine-adapters · llm · retrieval · storage
infra/      docker (dev) · k8s (прод, TODO)
```

## Потік даних (event-driven)

```
source.registered → discovery → url.discovered → fetcher → page.fetched
   → extractor → draft.extracted → normalizer → draft.normalized
   → resolver → product.updated → indexer → product.indexed
                                              ↓
                              Qdrant ← chat-orchestrator ← api ← web
```

Сервіси зв'язані **лише подіями** (NATS) і сховищами. Публікація подій — через
transactional outbox (`outbox-relay`), тому «записали в БД ⇒ подія точно вийде».

## Запуск (dev)

Потрібні: Node ≥ 20.11, pnpm 9, Docker, (для ML) Python ≥ 3.10 + uv.

```bash
# 1. Залежності
pnpm install

# 2. Інфраструктура (postgres, nats, qdrant, minio, redis)
cp .env.example .env
pnpm infra:up

# 3. БД: міграції + seed (одне джерело, онтологія, категорія)
pnpm db:generate      # згенерувати SQL зі схеми Drizzle
pnpm db:migrate
pnpm db:seed

# 4. ML-сервіс (окремий термінал; перший старт тягне ваги моделей)
cd services/ml && uv sync && uv run uvicorn app:app --port 8080

# 5. LLM: локальний OpenAI-сумісний ендпоінт (vLLM/ollama) на LLM_BASE_URL
#    або LLM_PROVIDER=anthropic + LLM_API_KEY

# 6. Всі воркери + api + web
pnpm dev
```

Відкрити http://localhost:3000 — чат. API — http://localhost:3001.

## Локальний E2E ingest (без зовнішньої мережі й LLM)

Доводить наскрізний потік `source → canonical product з provenance` на детермінованому
JSON-LD-шляху проти живої інфраструктури. Піднімає локальний fixture-сайт «виробника»,
запускає воркери ingest і чекає канонічні товари:

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
pnpm smoke:ingest
```

Очікуваний результат — 2 канонічні товари, кожен атрибут нормалізований до SI і
посилається на URL сторінки виробника (provenance).

Якщо запущено ML-сервіс (достатньо dev-режиму, без GPU), той самий прогін додатково
**індексує чанки в Qdrant і перевіряє retrieval** (гібридний dense+sparse RRF):

```bash
# окремий термінал: легкий ML-сервіс (лексичні ембединги, без torch)
cd services/ml && python -m venv .venv && ./.venv/Scripts/pip install -e .
ML_DEV_MODE=1 ./.venv/Scripts/python -m uvicorn app:app --port 8091
# потім:
pnpm smoke:ingest   # тепер: ingest → index → retrieve, з перевіркою релевантності
```

## Ключові архітектурні рішення

| Вимога | Рішення |
|---|---|
| Довіра лише виробникам | Курируваний Source Registry з верифікацією доменів; provenance на кожен атрибут |
| Різні рушії сайтів | `@wiki/engine-adapters`: детектор + Strategy-адаптери (static/headless/api-replay/document) |
| Не вводити в оману | Чат відповідає лише з retrieved-контексту, цитати `[n]`, числа — зі structured-атрибутів |
| Масштаб | Stateless-воркери, NATS consumer groups, KEDA-скейл за глибиною черги |
| Порівняння | Детермінований diff канонічних атрибутів (код), LLM лише коментує |
| Еволюція | Immutable снапшоти + append-only revisions → будь-який етап можна переграти |

## Скрипти

```bash
pnpm build        # turbo build усього
pnpm typecheck    # перевірка типів
pnpm test         # vitest — юніт-тести чистої логіки
pnpm check:arch   # гвард архітектурних меж (scripts/check-arch.mjs)
pnpm lint         # eslint
pnpm smoke:ingest # локальний E2E ingest проти живої інфраструктури
pnpm infra:down   # зупинити інфраструктуру

node scripts/new-service.mjs <name> "<опис>" <in> <out>   # новий воркер за шаблоном
```

Правила для AI-агентів та інваріанти проєкту — [CLAUDE.md](./CLAUDE.md).

## Ліцензія / етика

Дотримуємось robots.txt і ToS беззастережно; rate ≤ 0.5 rps/домен; чесний User-Agent
з контактом. Зберігаємо факти + короткі цитати з атрибуцією на першоджерело.
