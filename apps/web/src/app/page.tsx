"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import type { ChatIntent, ProductCard, Citation, ComparisonTable } from "@wiki/contracts";
import { streamChat } from "@/lib/chat-stream";

interface Turn {
  role: "user" | "assistant";
  text: string;
  intent?: ChatIntent;
  cards?: ProductCard[];
  citations?: Citation[];
  comparison?: ComparisonTable;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Home() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | undefined>(undefined);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: message }, { role: "assistant", text: "" }]);

    const cards: ProductCard[] = [];
    const citations: Citation[] = [];
    try {
      for await (const ev of streamChat(API, { message, sessionId: sessionId.current })) {
        if (ev.type === "session") sessionId.current = ev.sessionId;
        else if (ev.type === "token")
          setTurns((t) => patchLast(t, (last) => ({ ...last, text: last.text + ev.text })));
        else if (ev.type === "intent")
          setTurns((t) => patchLast(t, (last) => ({ ...last, intent: ev.intent })));
        else if (ev.type === "product_card") {
          cards.push(ev.card);
          setTurns((t) => patchLast(t, (last) => ({ ...last, cards: [...cards] })));
        } else if (ev.type === "citation") {
          citations.push(ev.citation);
          setTurns((t) => patchLast(t, (last) => ({ ...last, citations: [...citations] })));
        } else if (ev.type === "comparison") {
          const table = ev.table as ComparisonTable;
          setTurns((t) => patchLast(t, (last) => ({ ...last, comparison: table })));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24, minHeight: "100vh" }}>
      <header style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h1 style={{ fontSize: 22, margin: 0 }}>🛍️ Вікіпедія товарів</h1>
          <Link href="/products" style={{ color: "#58a6ff", fontSize: 14 }}>
            Каталог →
          </Link>
        </div>
        <p style={{ color: "#8b93a1", fontSize: 14 }}>
          Достовірні дані лише з офіційних сайтів виробників. Кожна відповідь — з посиланням на
          джерело.
        </p>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 96 }}>
        {turns.map((t, i) => (
          <div key={i} style={{ alignSelf: t.role === "user" ? "flex-end" : "flex-start", maxWidth: "90%" }}>
            <div
              style={{
                background: t.role === "user" ? "#1f6feb" : "#161b22",
                border: "1px solid #22272e",
                padding: "10px 14px",
                borderRadius: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {t.intent && (
                <span style={{ fontSize: 11, color: "#8b93a1", display: "block", marginBottom: 4 }}>
                  intent: {t.intent}
                </span>
              )}
              {t.text || (t.role === "assistant" && busy ? "…" : "")}
              {t.cards?.map((c) => (
                <Link
                  key={c.productId}
                  href={`/products/${c.productId}`}
                  style={{
                    display: "block",
                    marginTop: 8,
                    padding: 8,
                    border: "1px solid #2d333b",
                    borderRadius: 8,
                    textDecoration: "none",
                    color: "#e7eaee",
                  }}
                >
                  <strong>{c.brand}</strong> {c.name} <span style={{ color: "#58a6ff", fontSize: 12 }}>→</span>
                </Link>
              ))}
              {t.comparison && <ComparisonView table={t.comparison} />}
              {t.citations && t.citations.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: "#8b93a1" }}>
                  Джерела:{" "}
                  {dedupeCitations(t.citations).map((c) => (
                    <a
                      key={c.marker}
                      href={c.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#58a6ff", marginRight: 8 }}
                    >
                      [{c.marker}]
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "#0b0d10",
          borderTop: "1px solid #22272e",
          padding: 16,
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Напр.: порадь тихий пилосос до 15000 грн · порівняй X і Y · яка вага Z?"
            style={{
              flex: 1,
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid #2d333b",
              background: "#0d1117",
              color: "#e7eaee",
              fontSize: 15,
            }}
          />
          <button
            onClick={send}
            disabled={busy}
            style={{ padding: "12px 20px", borderRadius: 10, border: "none", background: "#238636", color: "#fff", fontWeight: 600 }}
          >
            {busy ? "…" : "→"}
          </button>
        </div>
      </div>
    </main>
  );
}

function patchLast(turns: Turn[], fn: (t: Turn) => Turn): Turn[] {
  const copy = [...turns];
  const last = copy[copy.length - 1];
  if (last) copy[copy.length - 1] = fn(last);
  return copy;
}

/** Таблиця порівняння — будується КОДОМ на бекенді (compare.ts); тут лише рендер.
 *  Рядки з відмінностями підсвічуються, щоб різниця читалась з першого погляду. */
function ComparisonView({ table }: { table: ComparisonTable }) {
  return (
    <div style={{ marginTop: 10, overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "4px 8px", color: "#8b93a1" }}></th>
            {table.productNames.map((n) => (
              <th key={n} style={{ textAlign: "left", padding: "4px 8px" }}>
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.attrKey} style={{ background: r.differs ? "#1c2530" : "transparent" }}>
              <td style={{ padding: "4px 8px", color: "#8b93a1" }}>{r.label}</td>
              {r.values.map((v, i) => (
                <td key={i} style={{ padding: "4px 8px", fontWeight: r.differs ? 600 : 400 }}>
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

/** Одна цитата на джерело (marker), щоб не дублювати посилання. */
function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (seen.has(c.sourceUrl)) continue;
    seen.add(c.sourceUrl);
    out.push(c);
  }
  return out;
}
