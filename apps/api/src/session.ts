import Redis from "ioredis";

/** Стан сесії чату в Redis (TTL). Довга історія стискається LLM-summary (TODO). */
export class SessionStore {
  private redis: Redis;
  private ttl = 60 * 60 * 24; // 24h

  constructor(url = process.env.REDIS_URL ?? "redis://localhost:6379") {
    this.redis = new Redis(url);
  }

  async getHistory(sessionId: string): Promise<{ role: string; content: string }[]> {
    const raw = await this.redis.get(`chat:${sessionId}`);
    return raw ? (JSON.parse(raw) as { role: string; content: string }[]) : [];
  }

  async append(sessionId: string, role: string, content: string): Promise<void> {
    const history = await this.getHistory(sessionId);
    history.push({ role, content });
    // тримаємо останні 20 реплік
    const trimmed = history.slice(-20);
    await this.redis.set(`chat:${sessionId}`, JSON.stringify(trimmed), "EX", this.ttl);
  }
}
