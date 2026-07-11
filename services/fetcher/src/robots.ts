import { Agent, interceptors, request } from "undici";
import type Redis from "ioredis";
import { parseRobots, isPathAllowed } from "./robots-parser.js";

// undici 6+: редиректи лише через інтерцептор, не через опцію maxRedirections
const dispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: 3 }));

/**
 * Дотримання robots.txt — жорсткий інваріант (8). Ми соціальний проєкт і поводимось
 * зразково: заборонений шлях НЕ завантажуємо. Правила кешуються per-host у Redis.
 * Чиста логіка парсингу — у robots-parser.ts (юніт-тестується без мережі).
 */
export class RobotsGate {
  constructor(
    private redis: Redis,
    private userAgent: string,
  ) {}

  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    const key = `robots:${u.host}`;
    let raw = await this.redis.get(key);
    if (raw === null) {
      raw = await this.fetchRobots(u.origin);
      // порожній рядок кешуємо як "нема обмежень"
      await this.redis.set(key, raw, "EX", 3600);
    }
    if (!raw) return true;
    const rules = parseRobots(raw, this.userAgent);
    return isPathAllowed(rules, u.pathname);
  }

  private async fetchRobots(origin: string): Promise<string> {
    try {
      const res = await request(`${origin}/robots.txt`, {
        method: "GET",
        headers: { "user-agent": this.userAgent },
        dispatcher,
      });
      // 4xx (нема robots) → дозволено все; лише 2xx з тілом обмежує
      if (res.statusCode >= 200 && res.statusCode < 300) return await res.body.text();
      await res.body.dump();
      return "";
    } catch {
      return ""; // недоступний robots → не блокуємо (стандартна поведінка)
    }
  }
}
