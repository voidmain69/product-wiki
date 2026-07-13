"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import type { ProductCard, Citation, ComparisonTable, ProductDetail } from "@wiki/contracts";
import { streamChat } from "@/lib/chat-stream";
import { C, SERIF, SANS, HOVER_CSS } from "@/lib/theme";
import {
  type Turn,
  type Conversation,
  type Bookmark,
  loadConversations,
  saveConversation,
  deleteConversation,
  loadBookmarks,
  toggleBookmark as toggleBookmarkStore,
  groupConversations,
} from "@/lib/history";

/* ─────────────────────────────────────────────────────────────────────────
 * Дизайн «Чат Hi-Fi» — трьохколонковий дослідницький інтерфейс:
 *   ліворуч — реальна історія чатів і закладки (localStorage, з відновленням),
 *   центр   — реальний SSE-стрім чату з картками та цитатами,
 *   праворуч — жива вікі-сторінка активного товару з provenance (GET /products/:id).
 * Контекст товару прокидається в POST /chat через productContextId.
 * ────────────────────────────────────────────────────────────────────────*/

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Context {
  id: string;
  name: string;
}

/** Явний фільтр retrieval із UI (бренд або рівень категорії). */
interface FilterChip {
  kind: "brand" | "category";
  value: string;
}

export default function Home() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [activeProductId, setActiveProductId] = useState<string | undefined>();
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [compare, setCompare] = useState<{ id: string; name: string }[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [search, setSearch] = useState("");
  const [filterChips, setFilterChips] = useState<FilterChip[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // UI-чипи → RetrievalFilters у /chat.
  const apiFilters = useMemo(() => {
    const brand = filterChips.find((c) => c.kind === "brand")?.value;
    const categoryPath = filterChips.filter((c) => c.kind === "category").map((c) => c.value);
    const f: { brand?: string; categoryPath?: string[] } = {};
    if (brand) f.brand = brand;
    if (categoryPath.length) f.categoryPath = categoryPath;
    return Object.keys(f).length ? f : undefined;
  }, [filterChips]);
  const addFilter = (chip: FilterChip) =>
    setFilterChips((c) => (c.some((x) => x.kind === chip.kind && x.value === chip.value) ? c : [...c, chip]));
  const removeFilter = (i: number) => setFilterChips((c) => c.filter((_, j) => j !== i));
  const dirty = useRef(false); // чи є незбережені зміни поточного чату
  const urlProduct = useRef<string | null>(null); // товар, відкритий з вікі-сторінки (?product=)

  // Заголовок чату — з першого запиту користувача, інакше «Новий чат».
  const chatTitle = useMemo(
    () => turns.find((t) => t.role === "user")?.text ?? "Новий чат",
    [turns],
  );

  // Останнє повідомлення користувача — для евристики підсвітки атрибута у вікі-панелі.
  const lastUserText = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t?.role === "user") return t.text;
    }
    return "";
  }, [turns]);

  const bookmarkedIds = useMemo(() => new Set(bookmarks.map((b) => b.productId)), [bookmarks]);

  // Відфільтрована історія за пошуковим запитом (по заголовку й текстам реплік).
  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || c.turns.some((t) => t.text.toLowerCase().includes(q)),
    );
  }, [conversations, search]);

  // Початкове завантаження історії/закладок з localStorage.
  useEffect(() => {
    setConversations(loadConversations());
    setBookmarks(loadBookmarks());
    // перехід із вікі-сторінки «Питати про це» (?product=id): відкриваємо товар як
    // активний контекст RAG; параметр прибираємо з URL, щоб не липнув при newChat.
    const pid = new URLSearchParams(window.location.search).get("product");
    if (pid) {
      urlProduct.current = pid;
      setActiveProductId(pid);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Коли підвантажилась вікі-сторінка товару, відкритого з URL — робимо його контекстом
  // чату (scoping RAG) і показуємо в шапці.
  useEffect(() => {
    if (detail && urlProduct.current && detail.productId === urlProduct.current) {
      setContext({ id: detail.productId, name: `${detail.brand} ${detail.name}` });
      urlProduct.current = null;
    }
  }, [detail]);

  // Автоскрол донизу під час стрімінгу.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  // Активний товар → тягнемо реальну вікі-сторінку (provenance) для правої панелі.
  useEffect(() => {
    if (!activeProductId) {
      setDetail(null);
      return;
    }
    let alive = true;
    fetch(`${API}/products/${activeProductId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ProductDetail | null) => alive && setDetail(d))
      .catch(() => alive && setDetail(null));
    return () => {
      alive = false;
    };
  }, [activeProductId]);

  // Персистимо чат після завершення обміну (коли стрім завершився).
  useEffect(() => {
    if (busy || !dirty.current || !sessionId || turns.length === 0) return;
    dirty.current = false;
    setConversations(
      saveConversation({ id: sessionId, title: chatTitle, turns, productId: activeProductId, updatedAt: Date.now() }),
    );
  }, [busy, sessionId, turns, activeProductId, chatTitle]);

  async function send(text?: string, contextId?: string) {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    dirty.current = true;
    setTurns((t) => [...t, { role: "user", text: message }, { role: "assistant", text: "" }]);

    const cards: ProductCard[] = [];
    const citations: Citation[] = [];
    try {
      for await (const ev of streamChat(API, {
        message,
        sessionId,
        productContextId: contextId ?? context?.id, // scoping RAG до конкретного товару
        filters: apiFilters,
      })) {
        if (ev.type === "session") setSessionId(ev.sessionId);
        else if (ev.type === "token")
          setTurns((t) => patchLast(t, (l) => ({ ...l, text: l.text + ev.text })));
        else if (ev.type === "intent")
          setTurns((t) => patchLast(t, (l) => ({ ...l, intent: ev.intent })));
        else if (ev.type === "product_card") {
          cards.push(ev.card);
          setActiveProductId(ev.card.productId); // остання картка стає активною вікі-сторінкою
          setTurns((t) => patchLast(t, (l) => ({ ...l, cards: [...cards] })));
        } else if (ev.type === "citation") {
          citations.push(ev.citation);
          setActiveProductId((cur) => cur ?? ev.citation.productId);
          setTurns((t) => patchLast(t, (l) => ({ ...l, citations: [...citations] })));
        } else if (ev.type === "comparison") {
          const table = ev.table as ComparisonTable;
          setTurns((t) => patchLast(t, (l) => ({ ...l, comparison: table })));
        } else if (ev.type === "error") {
          setTurns((t) => patchLast(t, (l) => ({ ...l, text: l.text + `\n⚠ ${ev.message}` })));
        }
      }
    } catch {
      setTurns((t) => patchLast(t, (l) => ({ ...l, text: l.text || "⚠ Не вдалося отримати відповідь. Перевірте, що API запущено." })));
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    setTurns([]);
    setInput("");
    setSessionId(undefined);
    setActiveProductId(undefined);
    setContext(null);
    setCompare([]);
    setFilterChips([]);
    dirty.current = false;
  }

  function openConversation(id: string) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    dirty.current = false;
    setTurns(conv.turns);
    setSessionId(conv.id);
    setActiveProductId(conv.productId);
    setContext(null);
    setInput("");
  }

  function removeConversation(id: string) {
    setConversations(deleteConversation(id));
    if (id === sessionId) newChat();
  }

  function toggleBookmark(productId: string, name: string) {
    setBookmarks(toggleBookmarkStore(productId, name));
  }

  function addToCompare(id: string, name: string) {
    setCompare((c) => (c.some((x) => x.id === id) ? c : [...c, { id, name }].slice(-6)));
  }

  function askAbout(productId: string, name: string) {
    setContext({ id: productId, name });
    setActiveProductId(productId);
    void send(`Розкажи більше про ${name}`, productId);
  }

  return (
    <div
      style={{ display: "flex", height: "100vh", minHeight: 640, overflow: "hidden", background: C.bg, color: C.ink, fontFamily: SANS }}
    >
      <style dangerouslySetInnerHTML={{ __html: HOVER_CSS }} />

      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((s) => !s)}
        onNewChat={newChat}
        groups={groupConversations(filteredConversations)}
        bookmarks={bookmarks}
        activeId={sessionId}
        search={search}
        onSearch={setSearch}
        onOpen={openConversation}
        onDelete={removeConversation}
        onOpenBookmark={(pid) => setActiveProductId(pid)}
      />

      {/* ═══ Центральна колонка: чат ═══ */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: C.bg }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 28px",
            borderBottom: `1px solid ${C.borderSoft}`,
            gap: 16,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ font: `600 15px ${SERIF}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {chatTitle}
            </span>
            <span style={{ fontSize: 12, color: C.mut }}>
              Дані — лише з офіційних сайтів виробників · кожна відповідь із джерелом
            </span>
          </div>
          {context && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11.5,
                color: C.mut3,
                border: `1px solid ${C.border}`,
                borderRadius: 999,
                padding: "4px 10px 4px 12px",
                background: C.panel,
                whiteSpace: "nowrap",
                flex: "none",
              }}
            >
              Контекст: <b style={{ fontWeight: 600, color: C.terra }}>{context.name}</b>
              <button
                onClick={() => setContext(null)}
                title="Прибрати контекст"
                style={{ border: "none", background: "transparent", color: C.mut, cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1 }}
              >
                ✕
              </button>
            </span>
          )}
        </header>

        {/* стрічка повідомлень */}
        <div
          ref={scrollRef}
          className="pw-scroll"
          style={{ flex: 1, overflowY: "auto", padding: "28px 28px 12px", display: "flex", flexDirection: "column", gap: 24 }}
        >
          {turns.length === 0 ? (
            <EmptyState onPick={(q) => send(q)} />
          ) : (
            turns.map((t, i) => (
              <TurnView
                key={i}
                turn={t}
                busy={busy && i === turns.length - 1}
                bookmarkedIds={bookmarkedIds}
                onAddCompare={addToCompare}
                onAsk={askAbout}
                onBookmark={toggleBookmark}
              />
            ))
          )}
        </div>

        <Composer
          value={input}
          busy={busy}
          context={context}
          filters={filterChips}
          onChange={setInput}
          onSend={() => send()}
          onClearContext={() => setContext(null)}
          onRemoveFilter={removeFilter}
        />
      </main>

      <WikiPanel
        detail={detail}
        highlightKey={pickHighlightKey(detail, lastUserText)}
        compareCount={compare.length}
        bookmarked={detail ? bookmarkedIds.has(detail.productId) : false}
        onAddFilter={addFilter}
        onBookmark={() => detail && toggleBookmark(detail.productId, `${detail.brand} ${detail.name}`)}
        onAsk={() => detail && askAbout(detail.productId, `${detail.brand} ${detail.name}`)}
        onAddCompare={() => detail && addToCompare(detail.productId, `${detail.brand} ${detail.name}`)}
        onOpenTable={() => {
          if (compare.length >= 2) send(`Порівняй ${compare.map((c) => c.name).join(" та ")}`);
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════ Лівий сайдбар ═══════════════════════════ */

interface SidebarProps {
  open: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  groups: { label: string; items: Conversation[] }[];
  bookmarks: Bookmark[];
  activeId?: string;
  search: string;
  onSearch: (v: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenBookmark: (productId: string) => void;
}

function Sidebar(props: SidebarProps) {
  const { open, onToggle, onNewChat, groups, bookmarks, activeId, search, onSearch, onOpen, onDelete, onOpenBookmark } = props;
  const asideStyle: React.CSSProperties = {
    width: open ? 264 : 56,
    flex: "none",
    background: C.side,
    borderRight: `1px solid ${C.border}`,
    transition: "width .22s ease",
    overflow: "hidden",
  };

  if (!open) {
    return (
      <aside style={asideStyle}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", height: "100%", padding: "20px 0 16px", gap: 14 }}>
          <Logo mark />
          <IconBtn className="pw-side-btn" title="Розгорнути" onClick={onToggle} bordered>
            ››
          </IconBtn>
          <IconBtn title="Новий чат" onClick={onNewChat} dark>
            ＋
          </IconBtn>
          <IconBtn className="pw-side-btn" title="Історія" bordered onClick={onToggle}>
            🕘
          </IconBtn>
          <IconBtn className="pw-side-btn" title="Закладки" bordered terra onClick={onToggle}>
            ★
          </IconBtn>
          <div style={{ flex: 1 }} />
          <IconBtn className="pw-side-btn" title="Налаштування">
            ⚙
          </IconBtn>
        </div>
      </aside>
    );
  }

  const empty = groups.length === 0 && bookmarks.length === 0;

  return (
    <aside style={asideStyle}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "20px 16px 16px", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Logo />
          <button
            className="pw-collapse"
            onClick={onToggle}
            title="Згорнути"
            style={{ width: 28, height: 28, border: "none", background: "transparent", borderRadius: 7, color: C.mut3, cursor: "pointer", fontSize: 14 }}
          >
            ‹‹
          </button>
        </div>

        <button
          className="pw-newchat"
          onClick={onNewChat}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", border: "none", borderRadius: 10, background: C.dark, color: C.bg, font: `500 14px ${SANS}`, cursor: "pointer" }}
        >
          ＋ Новий чат
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 10, background: C.panel }}>
          <span style={{ color: C.mut, fontSize: 13 }}>⌕</span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Пошук по чатах"
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", font: `400 13px ${SANS}`, color: C.ink }}
          />
        </div>

        <div className="pw-scroll" style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, marginTop: 8 }}>
          {empty && (
            <div style={{ fontSize: 12.5, color: C.mut, padding: "12px", lineHeight: 1.6 }}>
              Історія порожня. Почніть діалог — чати збережуться тут автоматично.
            </div>
          )}

          {groups.map((g) => (
            <div key={g.label}>
              <div style={{ font: `600 10.5px ${SANS}`, letterSpacing: ".09em", color: C.mut, padding: "10px 12px 4px" }}>{g.label}</div>
              {g.items.map((c) => (
                <div
                  key={c.id}
                  className="pw-hist"
                  onClick={() => onOpen(c.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 8px 8px 12px",
                    borderRadius: 9,
                    fontSize: 13.5,
                    background: c.id === activeId ? "#e9e1d4" : undefined,
                    color: c.id === activeId ? C.ink : C.mut2,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</span>
                  <button
                    className="pw-del"
                    title="Видалити чат"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c.id);
                    }}
                    style={{ border: "none", background: "transparent", color: C.mut, cursor: "pointer", fontSize: 12, padding: 2, transition: "opacity .12s" }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}

          {bookmarks.length > 0 && (
            <>
              <div style={{ font: `600 10.5px ${SANS}`, letterSpacing: ".09em", color: C.mut, padding: "16px 12px 4px" }}>ЗАКЛАДКИ</div>
              {bookmarks.map((b) => (
                <div
                  key={b.productId}
                  className="pw-hist"
                  onClick={() => onOpenBookmark(b.productId)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 9, fontSize: 13.5, color: C.mut2, cursor: "pointer" }}
                >
                  <span style={{ color: C.terra }}>★</span>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 2 }}>
          <Link href="/products" className="pw-hist" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 9, fontSize: 13.5, color: C.mut2, cursor: "pointer", textDecoration: "none" }}>
            <span>▤</span> Каталог товарів
          </Link>
        </div>
      </div>
    </aside>
  );
}

function Logo({ mark }: { mark?: boolean }) {
  const badge = (
    <div style={{ width: 30, height: 30, borderRadius: 8, background: C.terra, color: "#fdfcfa", display: "flex", alignItems: "center", justifyContent: "center", font: `600 15px ${SERIF}` }}>
      W
    </div>
  );
  if (mark) return badge;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {badge}
      <span style={{ font: `600 16px ${SERIF}`, letterSpacing: "-.01em" }}>ProductWiki</span>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  className,
  bordered,
  dark,
  terra,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  className?: string;
  bordered?: boolean;
  dark?: boolean;
  terra?: boolean;
}) {
  return (
    <button
      className={className}
      title={title}
      onClick={onClick}
      style={{
        width: 32,
        height: 32,
        border: bordered ? `1px solid ${C.border}` : "none",
        background: dark ? C.dark : bordered ? C.panel : "transparent",
        borderRadius: 8,
        color: dark ? C.bg : terra ? C.terra : C.mut3,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════════ Центр: повідомлення ═════════════════════ */

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const examples = [
    "Порадь тихий робот-пилосос до 15 000 грн",
    "Порівняй RoboVac X20 і CleanBot S9",
    "Яка вага Bosch Serie 6?",
  ];
  return (
    <div style={{ margin: "auto", maxWidth: 520, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "40px 0" }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: C.terra, color: "#fdfcfa", display: "flex", alignItems: "center", justifyContent: "center", font: `600 22px ${SERIF}` }}>
        W
      </div>
      <div>
        <div style={{ font: `600 20px ${SERIF}`, marginBottom: 6 }}>Запитайте про товар</div>
        <div style={{ fontSize: 13.5, color: C.mut2, lineHeight: 1.6 }}>
          Відповіді — лише з офіційних сайтів виробників, кожна з посиланням на джерело. Числа беруться зі структурованих атрибутів, а не з опису.
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", marginTop: 4 }}>
        {examples.map((e) => (
          <button
            key={e}
            className="pw-example"
            onClick={() => onPick(e)}
            style={{ textAlign: "left", padding: "11px 16px", border: `1px solid ${C.border}`, background: C.panel, borderRadius: 12, font: `400 14px ${SANS}`, color: C.ink, cursor: "pointer", transition: "background .12s, border-color .12s" }}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

function TurnView({
  turn,
  busy,
  bookmarkedIds,
  onAddCompare,
  onAsk,
  onBookmark,
}: {
  turn: Turn;
  busy: boolean;
  bookmarkedIds: Set<string>;
  onAddCompare: (id: string, name: string) => void;
  onAsk: (id: string, name: string) => void;
  onBookmark: (id: string, name: string) => void;
}) {
  if (turn.role === "user") {
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "70%", background: C.userBubble, borderRadius: "16px 16px 4px 16px", padding: "11px 16px", fontSize: 14.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {turn.text}
      </div>
    );
  }

  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "88%", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 14.5, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
        {renderWithMarkers(turn.text)}
        {!turn.text && busy && <span style={{ color: C.mut }}>…</span>}
      </div>

      {turn.cards?.map((c) => (
        <ProductCardView
          key={c.productId}
          card={c}
          bookmarked={bookmarkedIds.has(c.productId)}
          onAdd={onAddCompare}
          onAsk={onAsk}
          onBookmark={onBookmark}
        />
      ))}

      {turn.comparison && <ComparisonView table={turn.comparison} />}

      {turn.citations && turn.citations.length > 0 && (
        <div style={{ fontSize: 12, color: C.mut }}>
          Джерела:{" "}
          {dedupeCitations(turn.citations).map((c, i) => (
            <span key={c.marker}>
              {i > 0 && <span style={{ color: "#d8ccb9" }}> · </span>}
              <a className="pw-wikilink" href={c.sourceUrl || "#"} target="_blank" rel="noreferrer">
                [{c.marker}] {c.sourceUrl ? shortHost(c.sourceUrl) : c.productName || "джерело"}
              </a>
              {c.snapshotDate && <span style={{ color: C.mut }}> · знімок {fmtDate(c.snapshotDate)}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductCardView({
  card,
  bookmarked,
  onAdd,
  onAsk,
  onBookmark,
}: {
  card: ProductCard;
  bookmarked: boolean;
  onAdd: (id: string, name: string) => void;
  onAsk: (id: string, name: string) => void;
  onBookmark: (id: string, name: string) => void;
}) {
  const full = `${card.brand} ${card.name}`;
  return (
    <div style={{ display: "flex", gap: 16, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, maxWidth: 560, boxShadow: "0 1px 2px rgba(51,41,31,.04)" }}>
      <Thumb src={card.thumbnail} size={88} />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 }}>
        <div>
          <div style={{ font: `600 15px ${SERIF}` }}>{full}</div>
          {card.categoryPath.length > 0 && (
            <div style={{ fontSize: 11.5, color: C.mut }}>{card.categoryPath.join(" / ")}</div>
          )}
        </div>
        {card.keySpecs.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {card.keySpecs.map((s) => (
              <span key={s.label} title={s.label} style={{ fontSize: 12, color: C.mut2, background: C.chip, borderRadius: 6, padding: "3px 9px" }}>
                {s.value}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <button
            className="pw-terra-btn"
            onClick={() => onAsk(card.productId, full)}
            style={{ font: `500 12.5px ${SANS}`, padding: "6px 12px", borderRadius: 8, border: "none", background: C.terra, color: "#fdfcfa", cursor: "pointer" }}
          >
            Питати про це
          </button>
          <Link
            href={`/products/${card.productId}`}
            className="pw-ghost-btn"
            style={{ font: `500 12.5px ${SANS}`, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel, color: C.mut2, cursor: "pointer", textDecoration: "none" }}
          >
            Вікі-сторінка
          </Link>
          <button
            className="pw-ghost-btn"
            onClick={() => onAdd(card.productId, full)}
            style={{ font: `500 12.5px ${SANS}`, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel, color: C.mut2, cursor: "pointer" }}
          >
            ＋ Порівняти
          </button>
          <button
            className="pw-ghost-btn"
            title={bookmarked ? "Прибрати із закладок" : "Зберегти в закладки"}
            onClick={() => onBookmark(card.productId, full)}
            style={{ fontSize: 13, padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: bookmarked ? C.terra : C.panel, color: bookmarked ? "#fdfcfa" : C.terra, cursor: "pointer" }}
          >
            ★
          </button>
        </div>
      </div>
    </div>
  );
}

/** Таблиця порівняння будується КОДОМ на бекенді (compare.ts); тут лише рендер.
 *  Рядки з відмінностями підсвічуються, щоб різниця читалась з першого погляду. */
function ComparisonView({ table }: { table: ComparisonTable }) {
  return (
    <div className="pw-scroll" style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel, maxWidth: 560 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "10px 14px", color: C.mut, fontWeight: 600, borderBottom: `1px solid ${C.borderPanel}` }} />
            {table.productNames.map((n) => (
              <th key={n} style={{ textAlign: "left", padding: "10px 14px", font: `600 13px ${SERIF}`, borderBottom: `1px solid ${C.borderPanel}` }}>
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.attrKey} style={{ background: r.differs ? C.hlBg : "transparent" }}>
              <td style={{ padding: "9px 14px", color: C.mut3, borderTop: `1px solid ${C.borderPanel}` }}>{r.label}</td>
              {r.values.map((v, i) => (
                <td key={i} style={{ padding: "9px 14px", fontWeight: r.differs ? 600 : 400, borderTop: `1px solid ${C.borderPanel}` }}>
                  {v ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════════ Композер ════════════════════════════════ */

function Composer({
  value,
  busy,
  context,
  filters,
  onChange,
  onSend,
  onClearContext,
  onRemoveFilter,
}: {
  value: string;
  busy: boolean;
  context: Context | null;
  filters: FilterChip[];
  onChange: (v: string) => void;
  onSend: () => void;
  onClearContext: () => void;
  onRemoveFilter: (i: number) => void;
}) {
  return (
    <div style={{ padding: "12px 28px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {context && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.mut2, border: `1px solid ${C.border}`, background: C.panel, borderRadius: 999, padding: "4px 11px" }}>
            У контексті: <b style={{ fontWeight: 600, color: C.terra }}>{context.name}</b>
            <b onClick={onClearContext} style={{ color: C.mut, cursor: "pointer", fontWeight: 400 }}>✕</b>
          </span>
        )}
        {filters.map((f, i) => (
          <span key={`${f.kind}:${f.value}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.mut2, border: `1px solid ${C.border}`, background: C.panel, borderRadius: 999, padding: "4px 11px" }}>
            {f.kind === "brand" ? "Бренд" : "Категорія"}: <b style={{ fontWeight: 600 }}>{f.value}</b>
            <b onClick={() => onRemoveFilter(i)} style={{ color: C.mut, cursor: "pointer", fontWeight: 400 }}>✕</b>
          </span>
        ))}
        {!context && filters.length === 0 && (
          <span className="pw-filter-add" title="Додайте фільтр кліком на бренд/категорію у вікі-панелі" style={{ display: "inline-flex", alignItems: "center", font: `400 12px ${SANS}`, color: C.mut, border: `1px dashed #d8ccb9`, borderRadius: 999, padding: "4px 11px", cursor: "default" }}>
            ＋ фільтр
          </span>
        )}
      </div>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: "12px 14px", boxShadow: "0 1px 3px rgba(51,41,31,.05)" }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          placeholder="Спитайте про товар… Enter — надіслати"
          style={{ width: "100%", border: "none", outline: "none", background: "transparent", font: `400 14.5px ${SANS}`, color: C.ink, padding: "2px 0 10px" }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <ComposeIcon title="Прикріпити файл — фото товару, PDF-мануал (скоро)">📎</ComposeIcon>
            <ComposeIcon title="Команди: /порівняти /підібрати /характеристики (скоро)" mono>
              /
            </ComposeIcon>
            <ComposeIcon title="Голосовий ввід (скоро)">🎤</ComposeIcon>
          </div>
          <button
            className="pw-send"
            onClick={onSend}
            disabled={busy}
            title="Надіслати"
            style={{ width: 38, height: 34, border: "none", borderRadius: 9, background: C.terra, color: "#fdfcfa", cursor: busy ? "default" : "pointer", fontSize: 15, opacity: busy ? 0.7 : 1 }}
          >
            {busy ? "…" : "→"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ComposeIcon({ children, title, mono }: { children: React.ReactNode; title: string; mono?: boolean }) {
  return (
    <button
      className="pw-ghost-btn"
      title={title}
      style={{ width: 34, height: 34, border: `1px solid ${C.border}`, background: "transparent", borderRadius: 9, color: C.mut3, cursor: "pointer", font: mono ? "600 14px ui-monospace,monospace" : undefined, fontSize: mono ? undefined : 14 }}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════════ Права вікі-панель ═══════════════════════ */

function WikiPanel({
  detail,
  highlightKey,
  compareCount,
  bookmarked,
  onAddFilter,
  onBookmark,
  onAsk,
  onAddCompare,
  onOpenTable,
}: {
  detail: ProductDetail | null;
  highlightKey?: string;
  compareCount: number;
  bookmarked: boolean;
  onAddFilter: (chip: FilterChip) => void;
  onBookmark: () => void;
  onAsk: () => void;
  onAddCompare: () => void;
  onOpenTable: () => void;
}) {
  return (
    <aside style={{ width: 400, flex: "none", background: C.panel, borderLeft: `1px solid ${C.borderSoft}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 22px", borderBottom: `1px solid ${C.borderPanel}` }}>
        <span style={{ font: `600 10.5px ${SANS}`, letterSpacing: ".1em", color: C.mut }}>ВІКІ-СТОРІНКА · ЖИВИЙ ДОКУМЕНТ</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="pw-ghost-btn"
            onClick={onBookmark}
            disabled={!detail}
            title={bookmarked ? "Прибрати із закладок" : "Зберегти в закладки"}
            style={{ fontSize: 13, border: `1px solid ${C.border}`, background: bookmarked ? C.terra : C.panel, color: bookmarked ? "#fdfcfa" : C.terra, borderRadius: 8, padding: "5px 9px", cursor: detail ? "pointer" : "default", opacity: detail ? 1 : 0.5 }}
          >
            ★
          </button>
          <button
            className="pw-ghost-btn"
            onClick={onAddCompare}
            disabled={!detail}
            style={{ font: `500 12px ${SANS}`, border: `1px solid ${C.border}`, background: C.panel, color: C.mut2, borderRadius: 8, padding: "5px 11px", cursor: detail ? "pointer" : "default", opacity: detail ? 1 : 0.5 }}
          >
            ＋ до порівняння
          </button>
        </div>
      </div>

      {!detail ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center", gap: 12 }}>
          <div style={{ width: 56, height: 56, borderRadius: 12, background: "repeating-linear-gradient(45deg,#f3ede4,#f3ede4 7px,#ebe3d5 7px,#ebe3d5 14px)" }} />
          <div style={{ fontSize: 13.5, color: C.mut2, lineHeight: 1.6, maxWidth: 240 }}>
            Запитайте про товар або оберіть картку — тут відкриється жива вікі-сторінка з provenance кожної характеристики.
          </div>
        </div>
      ) : (
        <div className="pw-scroll" style={{ flex: 1, overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* шапка товару */}
          <div style={{ display: "flex", gap: 16 }}>
            <Thumb src={detail.images[0] ?? null} size={96} radius={12} />
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ font: `600 19px ${SERIF}`, letterSpacing: "-.01em", lineHeight: 1.2 }}>
                <span onClick={() => onAddFilter({ kind: "brand", value: detail.brand })} title="Фільтрувати за брендом" style={{ cursor: "pointer" }}>
                  {detail.brand}
                </span>{" "}
                {detail.name}
              </div>
              {detail.categoryPath.length > 0 && (
                <div style={{ fontSize: 12, color: C.mut }}>
                  {detail.categoryPath.map((seg, i) => (
                    <span key={i}>
                      {i > 0 && " / "}
                      <span onClick={() => onAddFilter({ kind: "category", value: seg })} title="Фільтрувати за категорією" style={{ cursor: "pointer" }} className="pw-wikilink">
                        {seg}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              <span style={{ alignSelf: "flex-start", fontSize: 11, color: C.freshInk, background: C.freshBg, borderRadius: 999, padding: "3px 10px" }}>
                оновлено {fmtDate(detail.updatedAt)}
              </span>
            </div>
          </div>

          {/* дії */}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pw-terra-btn" onClick={onAsk} style={{ font: `500 12.5px ${SANS}`, padding: "7px 14px", borderRadius: 9, border: "none", background: C.terra, color: "#fdfcfa", cursor: "pointer" }}>
              Питати про це
            </button>
            <Link href={`/products/${detail.productId}`} className="pw-ghost-btn" style={{ font: `500 12.5px ${SANS}`, padding: "7px 14px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.panel, color: C.mut2, cursor: "pointer", textDecoration: "none" }}>
              Повна сторінка ↗
            </Link>
          </div>

          {/* характеристики з provenance */}
          {detail.attributes.length > 0 && (
            <div>
              <SectionLabel>ХАРАКТЕРИСТИКИ · З PROVENANCE</SectionLabel>
              <div style={{ border: `1px solid ${C.borderPanel}`, borderRadius: 12, overflow: "hidden" }}>
                {detail.attributes.map((a, i) => {
                  const hl = a.key === highlightKey;
                  return (
                    <div
                      key={a.key}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1.3fr",
                        fontSize: 13.5,
                        background: hl ? C.hlBg : undefined,
                        borderLeft: hl ? `3px solid ${C.terra}` : "3px solid transparent",
                        borderTop: i === 0 ? "none" : `1px solid ${C.borderPanel}`,
                      }}
                    >
                      <div style={{ padding: "10px 14px", color: C.mut3 }}>{a.label}</div>
                      <div style={{ padding: "10px 14px" }}>
                        <b style={{ fontWeight: hl ? 600 : 400 }}>{fmtAttrValue(a.value, a.unit)}</b>{" "}
                        <a className="pw-wikilink" href={a.sourceUrl} target="_blank" rel="noreferrer" title={`Джерело, знімок ${fmtDate(a.snapshotDate)}`} style={{ fontSize: 11.5 }}>
                          ↗ {shortHost(a.sourceUrl)}
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
              {highlightKey && (
                <div style={{ fontSize: 11.5, color: C.mut, marginTop: 8 }}>Підсвічений рядок — атрибут з останньої відповіді чату</div>
              )}
            </div>
          )}

          {/* опис */}
          {detail.texts.length > 0 && (
            <div>
              <SectionLabel>ОПИС</SectionLabel>
              {detail.texts.map((t, i) => (
                <p key={i} style={{ margin: i === 0 ? 0 : "8px 0 0", fontSize: 13.5, lineHeight: 1.65, color: C.mut2 }}>
                  {t.text}{" "}
                  <a className="pw-wikilink" href={t.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                    ↗ джерело
                  </a>
                </p>
              ))}
            </div>
          )}

          {/* джерела */}
          {detail.sources.length > 0 && (
            <div>
              <SectionLabel>ДЖЕРЕЛА</SectionLabel>
              <div style={{ fontSize: 12.5, color: C.mut2, display: "flex", flexDirection: "column", gap: 5 }}>
                {detail.sources.map((s, i) => (
                  <div key={i}>
                    <a className="pw-wikilink" href={s.url} target="_blank" rel="noreferrer">
                      {shortHost(s.url)}
                    </a>{" "}
                    <span style={{ color: C.mut }}>· знімок {fmtDate(s.fetchedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ borderTop: `1px solid ${C.borderPanel}`, padding: "12px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#faf6f0" }}>
        <span style={{ fontSize: 12.5, color: C.mut2 }}>
          Порівняння: <b>{plural(compareCount)}</b>
        </span>
        <button
          className="pw-dark-btn"
          onClick={onOpenTable}
          disabled={compareCount < 2}
          style={{ font: `500 12.5px ${SANS}`, border: "none", background: C.dark, color: C.bg, borderRadius: 8, padding: "7px 14px", cursor: compareCount < 2 ? "default" : "pointer", opacity: compareCount < 2 ? 0.5 : 1 }}
        >
          Відкрити таблицю →
        </button>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ font: `600 11px ${SANS}`, letterSpacing: ".09em", color: C.mut, marginBottom: 10 }}>{children}</div>;
}

/** Плейсхолдер фото товару в стилі дизайну (діагональна штриховка). */
function Thumb({ src, size, radius = 10 }: { src: string | null; size: number; radius?: number }) {
  if (src) {
    return <img src={src} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: radius, objectFit: "cover", flex: "none" }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: radius, flex: "none", background: "repeating-linear-gradient(45deg,#f3ede4,#f3ede4 7px,#ebe3d5 7px,#ebe3d5 14px)", display: "flex", alignItems: "center", justifyContent: "center", font: "11px ui-monospace,monospace", color: C.mut }}>
      фото
    </div>
  );
}

/* ═══════════════════════════════ Хелпери ═════════════════════════════════ */

function patchLast(turns: Turn[], fn: (t: Turn) => Turn): Turn[] {
  const copy = [...turns];
  const last = copy[copy.length - 1];
  if (last) copy[copy.length - 1] = fn(last);
  return copy;
}

/** Одна цитата на джерело (marker), щоб не дублювати посилання. */
function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = c.sourceUrl || String(c.marker);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Маркери [n] у тексті відповіді робимо надрядковими, як у дизайні. */
function renderWithMarkers(text: string): React.ReactNode {
  if (!text) return null;
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((p, i) =>
    /^\[\d+\]$/.test(p) ? (
      <sup key={i} style={{ fontSize: 12, color: C.terra, verticalAlign: "super" }}>
        {p}
      </sup>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

/** Евристика підсвітки: атрибут, чия назва згадана в останньому запиті користувача. */
function pickHighlightKey(detail: ProductDetail | null, lastUser: string): string | undefined {
  if (!detail || !lastUser) return undefined;
  const q = lastUser.toLowerCase();
  const hit = detail.attributes.find((a) => a.label && q.includes(a.label.toLowerCase()));
  return hit?.key;
}

function shortHost(url: string): string {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** valueRaw зазвичай уже містить одиницю ("2560x1440", "0.233 мм"); дописуємо
 *  unitCanonical лише коли значення — «голе» число (напр. вага "3.4" → "3.4 kg"). */
function fmtAttrValue(value: string, unit: string | null): string {
  const bare = /^[\d.,\s-]+$/.test(value.trim());
  return bare && unit ? `${value} ${unit}` : value;
}

function fmtDate(iso: string): string {
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}.${m}.${y}` : d;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} товар`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} товари`;
  return `${n} товарів`;
}
