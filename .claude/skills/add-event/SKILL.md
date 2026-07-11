---
name: add-event
description: Додати нову подію в шину NATS. Використовуй при розширенні пайплайна новим subject-ом — подія додається в contracts у 4 місцях, інакше typed-клієнт її не побачить.
---

# Нова подія шини

Всі зміни — в одному файлі [packages/contracts/src/events.ts](../../../packages/contracts/src/events.ts).
Подія має бути додана в **усі 4 місця**, інакше `EventBus.publish/subscribe` не тайпчекнеться:

## Кроки

1. **Subject** — у const `EventSubjects`, ієрархічно `wiki.<domain>.<event>`:
   - `wiki.crawl.*` — здобуття (discovery/fetcher)
   - `wiki.process.*` — обробка (extractor/normalizer/resolver)
   - `wiki.index.*` — індексація
   - `wiki.dlq.*` — помилки

2. **Схема** — через хелпер `envelope(subject, payload)`:
   ```ts
   export const ThingHappened = envelope(
     EventSubjects.ThingHappened,
     z.object({ thingId: Id /* мінімальний payload: id-посилання, не цілі сутності */ }),
   );
   ```
   Payload несе **посилання** (id, snapshotRef), а не дані — консюмер сам читає зі сховища.

3. **Union** — додай схему в `AnyEvent` discriminated union.

4. **Мапа** — додай пару в `EventSchemas`.

5. **Consumer/producer:**
   - producer після запису в БД → вставка в `outbox` у тій самій транзакції (інваріант 2 CLAUDE.md);
   - consumer — durable з ім'ям сервісу, ідемпотентний.

6. **Перевір і задокументуй:**
   ```bash
   pnpm typecheck && pnpm check:arch
   ```
   Онови таблицю подій в `ARCHITECTURE.md` (розділ 6.5) та потік у `README.md`.
