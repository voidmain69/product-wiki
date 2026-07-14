import { and, eq, gte, sql, desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, chatQueries } from "@wiki/db";
import type { DemandReport, DemandItem } from "@wiki/contracts";
import { parseDemandParams, noResultsShare } from "./analytics-query.js";

/**
 * Аналітика попиту → сигнал куди розширювати каталог. `no_results` пише chat-orchestrator
 * (запити, на які чат чесно відповів «не знаю»). Ендпоінт агрегує їх за період — куратор
 * бачить, яких товарів/тем бракує, і реєструє нове джерело (петля людська, інваріант 8).
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const db = createDb();

  app.get("/analytics/demand", async (req): Promise<DemandReport> => {
    const { days, limit } = parseDemandParams(req.query as Record<string, unknown>);
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const [{ total }] = (await db
      .select({ total: sql<number>`count(*)::int` })
      .from(chatQueries)
      .where(gte(chatQueries.createdAt, cutoff))) as [{ total: number }];

    const [{ nr }] = (await db
      .select({ nr: sql<number>`count(*)::int` })
      .from(chatQueries)
      .where(and(gte(chatQueries.createdAt, cutoff), eq(chatQueries.noResults, true)))) as [{ nr: number }];

    const top = async (noResults: boolean): Promise<DemandItem[]> => {
      const rows = await db
        .select({
          queryText: chatQueries.queryText,
          count: sql<number>`count(*)::int`,
          lastAt: sql<string>`max(${chatQueries.createdAt})`,
        })
        .from(chatQueries)
        .where(and(gte(chatQueries.createdAt, cutoff), eq(chatQueries.noResults, noResults)))
        .groupBy(chatQueries.queryText)
        .orderBy(desc(sql`count(*)`))
        .limit(limit);
      return rows.map((r) => ({
        queryText: r.queryText,
        count: Number(r.count),
        lastAt: new Date(r.lastAt).toISOString(),
      }));
    };

    return {
      periodDays: days,
      total,
      noResultsTotal: nr,
      noResultsShare: noResultsShare(nr, total),
      topNoResults: await top(true),
      topMatched: await top(false),
    };
  });
}
