import type Redis from "ioredis";

/**
 * Розподілений token-bucket per-domain у Redis. Гарантує ввічливість
 * (≤ maxRps на домен) навіть коли паралельно працює багато fetcher-подів.
 */
export class DomainRateLimiter {
  constructor(private redis: Redis) {}

  /** Чекає, доки не звільниться слот для домену. */
  async acquire(domain: string, maxRps: number): Promise<void> {
    const minIntervalMs = Math.ceil(1000 / maxRps);
    const key = `ratelimit:${domain}`;
    while (true) {
      const now = Date.now();
      // NX: ставимо мітку часу лише якщо слот вільний
      const ok = await this.redis.set(key, String(now), "PX", minIntervalMs, "NX");
      if (ok === "OK") return;
      const ttl = await this.redis.pttl(key);
      await sleep(Math.max(ttl, 50));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
