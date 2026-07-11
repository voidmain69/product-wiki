import { describe, it, expect } from "vitest";
import { EventSubjects, EventSchemas, AnyEvent } from "./events.js";

describe("контракти подій — цілісність каталогу", () => {
  it("кожен subject має схему в EventSchemas (інваріант 1: усі 4 місця)", () => {
    for (const subject of Object.values(EventSubjects)) {
      expect(EventSchemas[subject], `нема схеми для ${subject}`).toBeDefined();
    }
  });

  it("валідна подія проходить парсинг зі своєю схемою", () => {
    const event = {
      id: "evt-1",
      subject: EventSubjects.PageFetched,
      traceId: "trace-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { sourceId: "s1", snapshotRef: "snap1", url: "https://example-manufacturer.com/p/1" },
    };
    expect(() => EventSchemas[EventSubjects.PageFetched].parse(event)).not.toThrow();
    // і через discriminated union
    expect(() => AnyEvent.parse(event)).not.toThrow();
  });

  it("подія з чужим payload відхиляється (валідація на межі)", () => {
    const bad = {
      id: "evt-1",
      subject: EventSubjects.PageFetched,
      traceId: "trace-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { sourceId: "s1" }, // бракує snapshotRef, url
    };
    expect(EventSchemas[EventSubjects.PageFetched].safeParse(bad).success).toBe(false);
  });

  it("невалідний URL у payload відхиляється", () => {
    const bad = {
      id: "e",
      subject: EventSubjects.UrlDiscovered,
      traceId: "t",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { sourceId: "s1", url: "not-a-url", priority: 0 },
    };
    expect(AnyEvent.safeParse(bad).success).toBe(false);
  });
});
