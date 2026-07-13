import Redis from "ioredis";
import type { LLMProvider } from "@wiki/llm";

interface SessionMessage {
  role: string;
  content: string;
}

interface SessionState {
  summary?: string; // стиснена «пам'ять» давніх реплік
  turns: SessionMessage[]; // останні дослівні репліки
}

/**
 * Стан сесії чату в Redis (TTL). Щоб контекст не ріс безмежно, давні репліки
 * стискаються LLM-summary: тримаємо коротке резюме + останні KEEP реплік дослівно.
 * Без LLM — деградуємо до простого тримінгу (dev/офлайн).
 */
export class SessionStore {
  private redis: Redis;
  private ttl = 60 * 60 * 24; // 24h
  private readonly KEEP = 12; // скільки останніх реплік лишати дослівно
  private readonly SUMMARIZE_AT = 20; // поріг, за яким стискаємо найдавніші

  constructor(
    private llm?: LLMProvider,
    url = process.env.REDIS_URL ?? "redis://localhost:6379",
  ) {
    this.redis = new Redis(url);
  }

  /** Історія для оркестратора: summary як system-репліка + останні дослівні. */
  async getHistory(sessionId: string): Promise<SessionMessage[]> {
    const s = await this.load(sessionId);
    return s.summary ? [{ role: "system", content: `Стисло з попередньої розмови: ${s.summary}` }, ...s.turns] : s.turns;
  }

  async append(sessionId: string, role: string, content: string): Promise<void> {
    const s = await this.load(sessionId);
    s.turns.push({ role, content });

    if (s.turns.length > this.SUMMARIZE_AT && this.llm) {
      const fold = s.turns.slice(0, s.turns.length - this.KEEP); // найдавніші — у резюме
      s.turns = s.turns.slice(-this.KEEP);
      s.summary = await this.summarize(s.summary, fold).catch(() => s.summary);
    } else if (s.turns.length > this.SUMMARIZE_AT) {
      s.turns = s.turns.slice(-this.KEEP); // без LLM — просто тримінг
    }

    await this.redis.set(`chat:${sessionId}`, JSON.stringify(s), "EX", this.ttl);
  }

  private async load(sessionId: string): Promise<SessionState> {
    const raw = await this.redis.get(`chat:${sessionId}`);
    if (!raw) return { turns: [] };
    // сумісність зі старим форматом (масив реплік)
    const parsed = JSON.parse(raw) as SessionState | SessionMessage[];
    return Array.isArray(parsed) ? { turns: parsed } : parsed;
  }

  /** Оновлює резюме, вплітаючи найдавніші репліки (лише факти діалогу, без вигадок). */
  private async summarize(prev: string | undefined, fold: SessionMessage[]): Promise<string> {
    const dialog = fold.map((m) => `${m.role}: ${m.content}`).join("\n");
    return this.llm!.generate(
      [
        {
          role: "system",
          content:
            "Стисни діалог у 2-4 реченнях: які товари/категорії й критерії цікавлять користувача, " +
            "які уточнення вже зроблено. Лише факти з діалогу, без вигадок.",
        },
        { role: "user", content: `${prev ? `Поточне резюме: ${prev}\n\n` : ""}Нові репліки:\n${dialog}` },
      ],
      { temperature: 0 },
    );
  }
}
