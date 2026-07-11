# CLAUDE.md — Вікіпедія товарів

Некомерційний RAG-сервіс достовірної інформації про товари. Дані — **лише з офіційних
сайтів виробників**; кожен факт має provenance; чат відповідає лише з retrieved-контексту
з цитатами. Повний дизайн: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Команди

```bash
pnpm install                 # залежності монорепо
pnpm infra:up / infra:down   # dev-інфраструктура (postgres, nats, qdrant, minio, redis)
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev                     # всі воркери + api + web (turbo)
pnpm typecheck               # перевірка типів усіх пакетів
pnpm test                    # vitest — юніт-тести чистої логіки (колокуються як *.test.ts)
pnpm check:arch              # ГВАРД АРХІТЕКТУРИ — запускати після будь-яких змін імпортів
pnpm lint                    # eslint
node scripts/new-service.mjs <name> "<опис>" <subject-in> <subject-out>   # новий воркер
pnpm --filter @wiki/api register-source <abs-path-to-source.json>         # реєстрація джерела
cd services/ml && uv run uvicorn app:app --port 8091                      # ML-сервіс (Python, prod)
ML_DEV_MODE=1 python -m uvicorn app:app --port 8091                       # ML dev (лексичні ембединги, без torch)
pnpm smoke:ingest                                                         # E2E: ingest → index → retrieve → chat (якщо ML up)
```

> Dev-режими без GPU/LLM: `ML_DEV_MODE=1` (лексичні ембединги) і `LLM_DEV_MODE=1`
> (детермінований LLM-провайдер, evристичний intent + цитований відповідь). Реальні
> BGE-M3/LLM — заміна конфігу (`LLM_PROVIDER=local|anthropic`, `ML` prod-extra), без змін коду.

> Порти інфраструктури конфігуруються через `*_PORT` у `.env` (compose читає `--env-file .env`);
> зсувай лише за конфлікту портів і синхронно онови відповідні `*_URL`.

## Карта монорепо

- `packages/contracts` — **центр всесвіту**: zod-схеми подій/сутностей/DTO. Не імпортує нічого внутрішнього.
- `packages/{db,events,engine-adapters,llm,retrieval,storage}` — інфраструктурні пакети; імпортують лише `@wiki/contracts`.
- `services/*` — stateless-воркери; спілкуються **тільки через події NATS + сховища**; ніколи не імпортують один одного. Виняток: `services/chat-orchestrator` — бібліотека, яку споживає `apps/api`.
- `apps/api` — Fastify + SSE; `apps/web` — Next.js, імпортує лише `@wiki/contracts`.
- `services/ml` — Python (FastAPI): embeddings BGE-M3 + rerank. Node-клієнт — `@wiki/retrieval`.

Потік подій: `source.registered → url.discovered → page.fetched → draft.extracted →
draft.normalized → product.updated → product.indexed`. Каталог subject-ів і схем —
[packages/contracts/src/events.ts](packages/contracts/src/events.ts).

## Жорсткі інваріанти (порушення = баг)

1. **Contracts first.** Нова подія/сутність/DTO починається зі zod-схеми в `packages/contracts`; сервіси валідують на межах. Подію додавати: схема + `EventSubjects` + `EventSchemas` + `AnyEvent` union (усі 4 місця).
2. **Outbox для подій після запису в БД.** Якщо сервіс пише доменні дані в Postgres і має опублікувати подію — подія вставляється в таблицю `outbox` **у тій самій транзакції** (доставляє `services/outbox-relay`). Прямий `bus.publish` дозволено лише коли запису в БД немає (напр. `page.unchanged`).
3. **Ідемпотентність консюмерів.** JetStream = at-least-once; ключ ідемпотентності — `snapshotRef`/`revisionId`/`event.id`. `traceId` протягується наскрізь без змін.
4. **Immutable + append-only.** `page_snapshots` не оновлюються; зміни canonical-товару — лише новою `product_revisions`. Будь-який етап має бути replay-able зі снапшотів.
5. **Provenance обов'язковий.** Кожен атрибут/текст canonical-товару посилається на `source_snapshot_id`. Факт без джерела не потрапляє в БД.
6. **LLM — останній рубіж.** В екстракції каскад: JSON-LD → API payloads → recipes → LLM (зі строгою zod-схемою + self-check «значення є на сторінці»). Ніколи не починати з LLM.
7. **Чат не вигадує.** Відповіді лише з retrieved-контексту з маркерами `[n]`; числа — зі structured-атрибутів; таблиця порівняння будується **кодом** (`compare.ts`), LLM лише коментує. Немає даних → чесне «не знаю».
8. **Ввічливий краулінг.** robots.txt — жорстке правило; rate ≤ 0.5 rps/домен (token-bucket у Redis); User-Agent з контактом. Нове джерело — лише через курируваний Source Registry.
9. **Новий рушій сайту = новий адаптер** (`EngineAdapter`) у `packages/engine-adapters`, зареєстрований у `AdapterRegistry`. Ядро fetcher-а не змінюється.
10. **Абстракції не обходити:** NATS — лише через `@wiki/events`; Postgres-драйвер — лише в `@wiki/db`; MinIO — лише в `@wiki/storage`; LLM HTTP — лише в `@wiki/llm`; Qdrant/ML — лише в `@wiki/retrieval`.

## Конвенції коду

- ESM всюди (`"type": "module"`); відносні імпорти з суфіксом `.js` (крім `apps/web`).
- Внутрішні залежності — `workspace:*`; заборонені deep-імпорти `@wiki/x/src/...` чи `@wiki/x/dist/...` (дозволені лише exports з package.json: `@wiki/contracts/events` тощо).
- Кожен воркер: `src/main.ts` з `main().catch(...)`, durable-ім'я консюмера = ім'я сервісу, обробка `SIGTERM` з `bus.drain()`.
- tsconfig кожного пакета — `extends: ../../tsconfig.base.json` (strict, verbatimModuleSyntax).
- Ідентифікатори — англійською; коментарі та документація — українською. Коментарі пояснюють інваріанти й «чому», не «що».
- Скелетні спрощення позначати `// TODO:` з описом повної реалізації.

## Git-конвенції

- **Мова:** коміти, назви гілок, PR-описи — **англійською**. (Документація і коментарі в коді — українською, як і раніше.)
- **Гілки:**
  - `main` — захищена; тільки PR з `develop`, прямі пуші та force-push заборонені; CI має бути зелений.
  - `develop` — інтеграційна гілка; сюди мержаться feature-гілки через PR.
  - Робочі гілки — **завжди від `develop`**: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`, `docs/<scope>` (напр. `feat/api-replay-adapter`).
- **Коміти:** Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`; scope за юнітом монорепо (напр. `feat(extractor): add recipe cascade level`). Імперативний стан, ≤72 символи в заголовку.
- **Перед пушем:** `pnpm check:arch && pnpm typecheck` мають проходити локально.
- **PR:** feature → `develop`; реліз — PR `develop` → `main`. Squash-merge для feature-гілок.

## Інструменти якості

- `scripts/check-arch.mjs` — перевіряє межі шарів і заборонені імпорти (правила = інваріант 10 + карта монорепо). Автоматично запускається хуком після Edit/Write.
- `scripts/new-service.mjs` — генерує воркер за канонічним шаблоном (щоб нові сервіси не дрейфували від конвенцій).
- Навички: `/new-service`, `/add-event`, `/add-engine-adapter` — покрокові чеклісти консистентних змін.

## Поточний стан (Фаза 1 — скелет)

`pnpm install` ще не запускався; typecheck може виявити дрібні неув'язки. Відомі
скелетні спрощення: exact-match entity resolution (fuzzy → merge_queue TODO),
sitemap-only discovery, спрощений XML-парсер, no_results-аналітика в scheduler.
