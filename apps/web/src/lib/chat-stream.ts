import type { ChatStreamEvent } from "@wiki/contracts";

/**
 * Клієнт SSE-стріму чату. POST /chat повертає text/event-stream;
 * читаємо його вручну (EventSource не підтримує POST).
 */
export async function* streamChat(
  apiUrl: string,
  body: {
    message: string;
    sessionId?: string;
    productContextId?: string;
    filters?: { brand?: string; categoryPath?: string[] };
  },
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`${apiUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error("no stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(5).trim()) as ChatStreamEvent;
      } catch {
        /* ignore keep-alive */
      }
    }
  }
}
