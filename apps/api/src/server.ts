import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createDb } from "@wiki/db";
import { createLLM } from "@wiki/llm";
import { MlClient, QdrantIndex } from "@wiki/retrieval";
import { runChat } from "@wiki/chat-orchestrator";
import { ChatRequest, type ChatStreamEvent } from "@wiki/contracts";
import { SessionStore } from "./session.js";
import { registerProductRoutes } from "./routes/products.js";

/**
 * Публічний API. Головний endpoint — POST /chat зі стрімінгом відповіді через SSE.
 * Сервіс безкоштовний → обов'язковий rate-limit проти зловживань.
 */
async function main() {
  const app = Fastify({ logger: true });
  // CORS: дозволяємо налаштований WEB_ORIGIN, а в dev — будь-який localhost
  // (порт web-сервера може відрізнятись, напр. 3002 якщо 3000 зайнятий).
  const strictOrigin = process.env.WEB_ORIGIN;
  const isAllowedOrigin = (origin?: string): boolean =>
    !origin ||
    origin === strictOrigin ||
    (process.env.NODE_ENV !== "production" &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  await app.register(cors, {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  });
  await app.register(rateLimit, {
    max: 30, // 30 повідомлень
    timeWindow: "1 minute", // за хвилину на IP
    redis: undefined, // у проді — спільний Redis для кластера
  });

  const deps = {
    db: createDb(),
    llm: createLLM(),
    ml: new MlClient(),
    qdrant: new QdrantIndex(new MlClient()),
  };
  const sessions = new SessionStore(deps.llm);

  app.get("/health", async () => ({ ok: true }));
  await registerProductRoutes(app);

  app.post("/chat", async (req, reply) => {
    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.flatten() };
    }
    const { message, productContextId } = parsed.data;
    const sessionId = parsed.data.sessionId ?? randomUUID();
    const history = await sessions.getHistory(sessionId);

    // SSE. Пишемо напряму в reply.raw, тому лайфсайкл Fastify (і onSend-хук
    // @fastify/cors) не спрацьовує — CORS-заголовок для стріму додаємо вручну
    // за тією ж політикою, що й плагін, інакше браузер заблокує читання відповіді.
    const origin = req.headers.origin;
    const sseHeaders: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (origin && isAllowedOrigin(origin)) {
      sseHeaders["access-control-allow-origin"] = origin;
      sseHeaders["vary"] = "Origin";
    }
    reply.raw.writeHead(200, sseHeaders);

    const send = (e: ChatStreamEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);

    let answer = "";
    try {
      for await (const event of runChat(deps, {
        sessionId,
        message,
        history,
        productContextId,
      })) {
        if (event.type === "token") answer += event.text;
        send(event);
      }
    } catch (err) {
      app.log.error(err);
      send({ type: "error", message: "Внутрішня помилка. Спробуйте ще раз." });
    } finally {
      await sessions.append(sessionId, "user", message);
      if (answer) await sessions.append(sessionId, "assistant", answer);
      reply.raw.end();
    }
  });

  const port = Number(process.env.API_PORT ?? 3001);
  // "::" — dual-stack: слухаємо і IPv6, і IPv4-mapped. Інакше на Windows браузер
  // резолвить localhost у ::1 (IPv6) і не достукається до IPv4-only сокета.
  await app.listen({ port, host: "::" });
  app.log.info(`api on :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
