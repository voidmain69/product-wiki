# Product Wiki · Вікіпедія товарів

A non-commercial, trustworthy **RAG service for product information** — data comes
**only from official manufacturer websites**, and every chat answer cites its source.

Некомерційний **RAG-сервіс достовірної інформації про товари** — дані **лише з
офіційних сайтів виробників**, кожна відповідь чату має посилання на першоджерело.

**[English](#english) · [Українською](#українською)** · Design: [ARCHITECTURE.md](./ARCHITECTURE.md) · AI-agent rules: [CLAUDE.md](./CLAUDE.md)

---

## English

### What it is

An event-driven pipeline that crawls manufacturer sites, extracts structured product
data with provenance, indexes it for hybrid semantic search, and answers user
questions through a grounded, citation-first chat. Built as a TypeScript monorepo;
Python is used only for ML inference.

### Status

**Phase 1 (MVP) complete and released.** Verified end-to-end against live
infrastructure, on **real manufacturer data** (Logitech) and **real GPU models**
(BGE-M3 + SPLADE + `bge-reranker-v2-m3` via HuggingFace TEI, and `qwen2.5` via
ollama). Dev↔real is an **environment switch, no code change**, so CI runs without a
GPU. Next up (Phase 2+): a curated multi-manufacturer Source Registry, LLM-fallback
spec extraction, fuzzy entity resolution, Kubernetes.

### What it does

- **Chat** with three intents, all grounded in retrieved context with `[n]` citations:
  - `info` — a product's specs (numbers come from structured attributes, not prose);
  - `recommend` — picks products by need (e.g. *"a quiet robot vacuum for a small flat"*);
  - `compare` — a **deterministic** attribute diff table (built in code; the LLM only comments).
- **Product pages** (SSR, SEO-indexable — the "wikipedia"): every spec is tagged with
  a link to its manufacturer source and snapshot date.
- **Trust guarantees:** data only from verified manufacturer domains; provenance on
  every attribute; the chat never invents — "no data" instead of guessing; robots.txt
  is a hard rule; polite rate-limiting.

### How it works

Stateless workers talk **only through NATS events + storage** (never import each
other). Events are published via a transactional outbox, so "written to DB ⇒ event is
guaranteed to be emitted".

```
source.registered → discovery → url.discovered → fetcher → page.fetched
   → extractor → draft.extracted → normalizer → draft.normalized
   → resolver → product.updated → indexer → product.indexed
                                              ↓
                              Qdrant ← chat-orchestrator ← api ← web
```

- **Fetcher** auto-detects the site engine (static / headless / api-replay / document)
  via pluggable adapters; respects robots.txt; stores immutable page snapshots in S3.
- **Extractor** runs a cascade *deterministic-first*: JSON-LD → API payloads →
  recipes → LLM (last resort, with a self-check that values appear on the page).
- **Normalizer** canonicalizes units to SI + maps raw labels to an attribute ontology.
- **Resolver** does entity resolution and writes append-only revisions with provenance.
- **Indexer** builds typed chunks (overview / spec / feature / usecase) and embeds
  them (BGE-M3 dense + sparse) into Qdrant.
- **Chat** = intent → hybrid retrieval (dense+sparse, RRF fusion) → rerank → grounded
  answer streamed over SSE with clickable citations.

### Project layout

```
apps/       web (Next.js chat + SSR product pages) · api (Fastify + SSE + REST)
services/   discovery · scheduler · fetcher · extractor · normalizer · resolver ·
            indexer · chat-orchestrator (lib) · outbox-relay · ml (Python)
packages/   contracts (zod schemas — the source of truth) · db (Drizzle) ·
            events (NATS) · engine-adapters · llm · retrieval (Qdrant) · storage (S3)
infra/      docker (dev stack) · sources (source definitions) · k8s (prod, TODO)
```

### Running it

**Prerequisites:** Node ≥ 20.11, pnpm 9, Docker. For ML: Python ≥ 3.10.

**1) Quick start (dev — no GPU, no external LLM):**
```bash
pnpm install
cp .env.example .env
pnpm infra:up                        # postgres, nats, qdrant, minio, redis
pnpm db:generate && pnpm db:migrate && pnpm db:seed

# lightweight ML service (deterministic lexical embeddings, no torch)
cd services/ml && python -m venv .venv && ./.venv/Scripts/pip install -e .
ML_DEV_MODE=1 ./.venv/Scripts/python -m uvicorn app:app --port 8091   # separate terminal

pnpm dev                             # all workers + api + web
```
Open http://localhost:3000 — chat; `/products` — catalog; API on http://localhost:3001.
With `ML_DEV_MODE=1` and `LLM_DEV_MODE=1` (in `.env`), the whole loop runs without a GPU.

**2) End-to-end smoke** (proves the full pipeline against live infra):
```bash
pnpm smoke:ingest    # ingest → index → retrieve → chat (real if ML/LLM up, else dev)
```

**3) Real models on a GPU host** — point env at HuggingFace TEI + an OpenAI-compatible
LLM (e.g. ollama), no code change:
```bash
# ml service proxies to GPU TEI (BGE-M3 dense + SPLADE sparse + bge-reranker-v2-m3)
ML_TEI_MODE=1 TEI_DENSE_URL=http://<gpu-host>:8081 \
  TEI_SPARSE_URL=http://<gpu-host>:8082 TEI_RERANK_URL=http://<gpu-host>:8083 \
  ./.venv/Scripts/python -m uvicorn app:app --port 8091
# .env: LLM_DEV_MODE=0  LLM_BASE_URL=http://<gpu-host>:11434/v1  LLM_MODEL=qwen2.5:7b-instruct
```

**4) Bounded live ingest of one real manufacturer page** (manual, polite — one fetch):
```bash
pnpm smoke:real infra/sources/logitech.json https://www.logitech.com/en-us/products/mice/mx-master-3s.html
```

### Scripts

```bash
pnpm dev · pnpm build · pnpm typecheck · pnpm lint · pnpm test   # vitest unit tests
pnpm check:arch          # architecture-boundary guard (scripts/check-arch.mjs)
pnpm infra:up / :down    # dev infrastructure
pnpm db:generate / :migrate / :seed
pnpm smoke:ingest        # full local E2E
pnpm smoke:real <src.json> <url>                        # one real page
node scripts/new-service.mjs <name> "<desc>" <in> <out> # scaffold a worker
```

### Quality & ethics

Every change passes an architecture guard (layer boundaries), typecheck, lint, unit
tests and a web build in CI; `main` is protected (PR + green CI only). We obey
robots.txt and ToS unconditionally, rate-limit ≤ 0.5 rps/domain, use an honest
User-Agent with contact, store facts + short attributed quotes, and always link back
to the manufacturer — so the source gets the traffic.

---

## Українською

### Що це

Подієвий конвеєр, що обходить сайти виробників, витягує структуровані дані про товари
з provenance, індексує їх для гібридного семантичного пошуку й відповідає на запити
користувачів через заземлений чат із цитатами. Зроблено як TypeScript-монорепо;
Python — лише для ML-інференсу.

### Поточний стан

**Фаза 1 (MVP) завершена і випущена.** Перевірено наскрізь проти живої
інфраструктури, на **реальних даних виробника** (Logitech) і **реальних GPU-моделях**
(BGE-M3 + SPLADE + `bge-reranker-v2-m3` через HuggingFace TEI, і `qwen2.5` через
ollama). Dev↔real — **перемикання env без змін коду**, тож CI працює без GPU. Далі
(Фаза 2+): курируваний Source Registry на багато виробників, LLM-fallback екстракції
специфікацій, fuzzy entity-resolution, Kubernetes.

### Що робить

- **Чат** із трьома intent-ами, усі заземлені в retrieved-контексті з цитатами `[n]`:
  - `info` — характеристики товару (числа — зі structured-атрибутів, не з тексту);
  - `recommend` — підбір за потребою (напр. *«тихий робот-пилосос для малої квартири»*);
  - `compare` — **детермінована** таблиця відмінностей атрибутів (будується кодом; LLM лише коментує).
- **Сторінки товарів** (SSR, індексовані пошуковиками — «вікіпедія»): кожна
  характеристика позначена посиланням на джерело виробника й датою снапшота.
- **Гарантії довіри:** дані лише з верифікованих доменів виробників; provenance на
  кожен атрибут; чат не вигадує — «немає даних» замість здогадки; robots.txt — жорстке
  правило; ввічливий rate-limit.

### Як воно працює

Stateless-воркери спілкуються **лише через події NATS + сховища** (ніколи не імпортують
один одного). Події публікуються через transactional outbox: «записали в БД ⇒ подія
точно вийде».

```
source.registered → discovery → url.discovered → fetcher → page.fetched
   → extractor → draft.extracted → normalizer → draft.normalized
   → resolver → product.updated → indexer → product.indexed
                                              ↓
                              Qdrant ← chat-orchestrator ← api ← web
```

- **Fetcher** автодетектує рушій сайту (static / headless / api-replay / document)
  через плагінні адаптери; дотримується robots.txt; кладе immutable-снапшоти в S3.
- **Extractor** — каскад *від детермінованого*: JSON-LD → API-payload-и → recipes →
  LLM (останній рубіж, із self-check «значення є на сторінці»).
- **Normalizer** канонізує одиниці до SI + мапить сирі мітки на онтологію атрибутів.
- **Resolver** — entity resolution + append-only ревізії з provenance.
- **Indexer** будує типізовані чанки (overview / spec / feature / usecase) і ембедить
  (BGE-M3 dense + sparse) у Qdrant.
- **Чат** = intent → гібридний retrieval (dense+sparse, RRF) → rerank → заземлена
  відповідь стрімом через SSE з клікабельними цитатами.

### Структура

```
apps/       web (Next.js чат + SSR-сторінки товарів) · api (Fastify + SSE + REST)
services/   discovery · scheduler · fetcher · extractor · normalizer · resolver ·
            indexer · chat-orchestrator (бібліотека) · outbox-relay · ml (Python)
packages/   contracts (zod-схеми — джерело правди) · db (Drizzle) · events (NATS) ·
            engine-adapters · llm · retrieval (Qdrant) · storage (S3)
infra/      docker (dev-стек) · sources (описи джерел) · k8s (прод, TODO)
```

### Запуск

**Потрібно:** Node ≥ 20.11, pnpm 9, Docker. Для ML: Python ≥ 3.10.

**1) Швидкий старт (dev — без GPU й зовнішнього LLM):**
```bash
pnpm install
cp .env.example .env
pnpm infra:up                        # postgres, nats, qdrant, minio, redis
pnpm db:generate && pnpm db:migrate && pnpm db:seed

# легкий ML-сервіс (детерміновані лексичні ембединги, без torch)
cd services/ml && python -m venv .venv && ./.venv/Scripts/pip install -e .
ML_DEV_MODE=1 ./.venv/Scripts/python -m uvicorn app:app --port 8091   # окремий термінал

pnpm dev                             # усі воркери + api + web
```
Відкрити http://localhost:3000 — чат; `/products` — каталог; API — http://localhost:3001.
З `ML_DEV_MODE=1` і `LLM_DEV_MODE=1` (у `.env`) весь цикл працює без GPU.

**2) Наскрізний smoke** (доводить увесь пайплайн проти живої інфри):
```bash
pnpm smoke:ingest    # ingest → index → retrieve → chat (реальні моделі якщо ML/LLM up, інакше dev)
```

**3) Реальні моделі на GPU-хості** — вкажи env на HuggingFace TEI + OpenAI-сумісний
LLM (напр. ollama), без змін коду:
```bash
# ml-сервіс проксіює на GPU TEI (BGE-M3 dense + SPLADE sparse + bge-reranker-v2-m3)
ML_TEI_MODE=1 TEI_DENSE_URL=http://<gpu-host>:8081 \
  TEI_SPARSE_URL=http://<gpu-host>:8082 TEI_RERANK_URL=http://<gpu-host>:8083 \
  ./.venv/Scripts/python -m uvicorn app:app --port 8091
# .env: LLM_DEV_MODE=0  LLM_BASE_URL=http://<gpu-host>:11434/v1  LLM_MODEL=qwen2.5:7b-instruct
```

**4) Обмежений живий ingest однієї реальної сторінки виробника** (manual, ввічливо — один fetch):
```bash
pnpm smoke:real infra/sources/logitech.json https://www.logitech.com/en-us/products/mice/mx-master-3s.html
```

### Скрипти

```bash
pnpm dev · pnpm build · pnpm typecheck · pnpm lint · pnpm test   # vitest юніт-тести
pnpm check:arch          # гвард архітектурних меж (scripts/check-arch.mjs)
pnpm infra:up / :down    # dev-інфраструктура
pnpm db:generate / :migrate / :seed
pnpm smoke:ingest        # повний локальний E2E
pnpm smoke:real <src.json> <url>                        # одна реальна сторінка
node scripts/new-service.mjs <name> "<опис>" <in> <out> # скафолд воркера
```

### Якість та етика

Кожна зміна проходить гвард архітектури (межі шарів), typecheck, lint, юніт-тести й
збірку web у CI; `main` захищена (лише PR + зелений CI). Дотримуємось robots.txt і ToS
беззастережно, rate ≤ 0.5 rps/домен, чесний User-Agent із контактом, зберігаємо факти
+ короткі цитати з атрибуцією й завжди посилаємось на виробника — щоб трафік ішов джерелу.
