"use client";

import { useState, useRef } from "react";
import type { ChatIntent, ProductCard } from "@wiki/contracts";
import { streamChat } from "@/lib/chat-stream";

interface Turn {
  role: "user" | "assistant";
  text: string;
  intent?: ChatIntent;
  cards?: ProductCard[];
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
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24, minHeight: "100vh" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>🛍️ Вікіпедія товарів</h1>
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
                <div key={c.productId} style={{ marginTop: 8, padding: 8, border: "1px solid #2d333b", borderRadius: 8 }}>
                  <strong>{c.brand}</strong> {c.name}
                </div>
              ))}
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
            placeholder="Напр.: порадь тихий робот-пилосос до 15000 грн"
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
