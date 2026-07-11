import type { EngineType, PageSnapshot } from "@wiki/contracts";

/** Задача на завантаження однієї сторінки. */
export interface FetchTask {
  url: string;
  sourceId: string;
  maxRps: number;
  engineHint?: EngineType;
  userAgent: string;
}

/** Дані першого (дешевого) HEAD/GET-зондування — вхід для детектора. */
export interface ProbeData {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  htmlSample: string; // перші ~64KB тіла (без повного рендеру)
}

/**
 * Результат fetch — усе, крім важких тіл (html/screenshots), які адаптер
 * сам вивантажує в object storage й повертає лише ключі. Тому Omit htmlKey
 * тут заповнюється, а сам html повертається окремо для стору.
 */
export interface FetchResult {
  snapshot: Omit<PageSnapshot, "snapshotRef">;
  htmlBody: string | null; // сире тіло для збереження в object storage
  screenshots: { key: string; bytes: Uint8Array }[];
}

/**
 * Контракт адаптера рушія. Нові рушії = нові реалізації цього інтерфейсу,
 * зареєстровані в registry — ядро fetcher-а не змінюється (Open/Closed).
 */
export interface EngineAdapter {
  readonly type: EngineType;
  /** Впевненість 0..1, що саме цей адаптер підходить для сторінки. */
  probe(url: string, probe: ProbeData): Promise<number>;
  /** Власне завантаження (для SPA — з рендером). */
  fetch(task: FetchTask, probe: ProbeData): Promise<FetchResult>;
  /** Звільнення ресурсів (браузерний пул тощо). */
  dispose?(): Promise<void>;
}
