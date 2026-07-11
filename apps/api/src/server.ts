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
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? true });
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
  const sessions = new SessionStore();

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

    // SSE
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

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
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`api on :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
