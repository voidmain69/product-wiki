import type { ChatIntent, ProductCard, Citation, ComparisonTable } from "@wiki/contracts";

/**
 * Клієнтська персистентність історії чатів і закладок (localStorage).
 * Сервер тримає стан сесії в Redis за sessionId (24h), але не має ендпойнта
 * «список усіх чатів» — тому перелік чатів/закладок живе на клієнті. Відновлення
 * чату переиспользує той самий sessionId → діалог у Redis продовжується реально.
 */

export interface Turn {
  role: "user" | "assistant";
  text: string;
  intent?: ChatIntent;
  cards?: ProductCard[];
  citations?: Citation[];
  comparison?: ComparisonTable;
}

export interface Conversation {
  id: string; // = sessionId (той самий, що в Redis)
  title: string;
  turns: Turn[];
  productId?: string; // активний товар — щоб відновити вікі-панель
  updatedAt: number; // epoch ms
}

export interface Bookmark {
  productId: string;
  name: string;
  addedAt: number;
}

const CONV_KEY = "pw.chats.v1";
const BM_KEY = "pw.bookmarks.v1";
const MAX_CONVERSATIONS = 50;

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, val: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* quota / приватний режим — історія best-effort, помилку ковтаємо */
  }
}

const byRecency = <T extends { updatedAt?: number; addedAt?: number }>(a: T, b: T) =>
  (b.updatedAt ?? b.addedAt ?? 0) - (a.updatedAt ?? a.addedAt ?? 0);

export function loadConversations(): Conversation[] {
  return read<Conversation[]>(CONV_KEY, []).sort(byRecency);
}

export function saveConversation(conv: Conversation): Conversation[] {
  const rest = read<Conversation[]>(CONV_KEY, []).filter((c) => c.id !== conv.id);
  const next = [conv, ...rest].sort(byRecency).slice(0, MAX_CONVERSATIONS);
  write(CONV_KEY, next);
  return next;
}

export function deleteConversation(id: string): Conversation[] {
  const next = read<Conversation[]>(CONV_KEY, []).filter((c) => c.id !== id).sort(byRecency);
  write(CONV_KEY, next);
  return next;
}

export function loadBookmarks(): Bookmark[] {
  return read<Bookmark[]>(BM_KEY, []).sort(byRecency);
}

export function toggleBookmark(productId: string, name: string): Bookmark[] {
  const all = read<Bookmark[]>(BM_KEY, []);
  const exists = all.some((b) => b.productId === productId);
  const next = (exists
    ? all.filter((b) => b.productId !== productId)
    : [{ productId, name, addedAt: Date.now() }, ...all]
  ).sort(byRecency);
  write(BM_KEY, next);
  return next;
}

/** Групування історії за днями для сайдбару (СЬОГОДНІ / ВЧОРА / РАНІШЕ). */
export function groupConversations(convs: Conversation[]): { label: string; items: Conversation[] }[] {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;
  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const earlier: Conversation[] = [];
  for (const c of convs) {
    if (c.updatedAt >= startToday) today.push(c);
    else if (c.updatedAt >= startYesterday) yesterday.push(c);
    else earlier.push(c);
  }
  return [
    { label: "СЬОГОДНІ", items: today },
    { label: "ВЧОРА", items: yesterday },
    { label: "РАНІШЕ", items: earlier },
  ].filter((g) => g.items.length > 0);
}
