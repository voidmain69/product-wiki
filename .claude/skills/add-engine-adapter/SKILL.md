---
name: add-engine-adapter
description: Додати адаптер нового рушія сайту (API-replay, PDF, нестандартний SPA тощо). Використовуй, коли сайт виробника не покривається static/headless адаптерами — ядро fetcher-а при цьому НЕ змінюється.
---

# Новий адаптер рушія

Інваріант 9: новий рушій = нова реалізація `EngineAdapter`, зареєстрована в
`AdapterRegistry`. Файли fetcher-а і registry-логіки вибору не чіпаємо (Open/Closed).

## Кроки

1. **Тип рушія.** Якщо це справді новий клас рушіїв (не покривається `static | headless | api-replay | document`) — спершу додай значення в enum `EngineType` у [packages/contracts/src/common.ts](../../../packages/contracts/src/common.ts). Інакше реалізуй наявний тип.

2. **Адаптер** — новий файл `packages/engine-adapters/src/adapters/<name>.ts`:
   ```ts
   export class MyAdapter implements EngineAdapter {
     readonly type = "api-replay" as const;
     async probe(url, probe): Promise<number> { /* впевненість 0..1, ДЕШЕВО без рендера */ }
     async fetch(task, probe): Promise<FetchResult> { /* повертає html/apiPayloads + contentHash */ }
     async dispose?(): Promise<void> { /* звільнити пул/ресурси */ }
   }
   ```
   Вимоги:
   - `probe()` не робить дорогих запитів — рішення за `ProbeData` (перші 64KB вже завантажені);
   - `contentHash` — sha256 фінального контенту (живить skip незмінених сторінок);
   - тіла НЕ вантажити в Postgres — адаптер повертає `htmlBody`/`screenshots`, fetcher сам кладе їх у MinIO;
   - дорогі залежності (браузер тощо) — лінивий `await import(...)`, як у `headless.ts`.

3. **Реєстрація** — додай у дефолтний список конструктора `AdapterRegistry` ([registry.ts](../../../packages/engine-adapters/src/registry.ts)) та в exports [index.ts](../../../packages/engine-adapters/src/index.ts).

4. **Детекція.** Якщо рушій можна розпізнати за маркерами HTML — додай евристику в `detector.ts`; інакше покладайся на `probe()` адаптера та `engineHint` у crawlPolicy джерела.

5. **Перевір:**
   ```bash
   pnpm check:arch && pnpm typecheck
   ```
   Онови розділ 5.3 в `ARCHITECTURE.md` (діаграма адаптерів).
