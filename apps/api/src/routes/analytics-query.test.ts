import { describe, it, expect } from "vitest";
import { parseDemandParams, noResultsShare, DEMAND_DAYS_DEFAULT, DEMAND_LIMIT_DEFAULT } from "./analytics-query.js";

describe("parseDemandParams", () => {
  it("дефолти на порожньому/невалідному", () => {
    expect(parseDemandParams({})).toEqual({ days: DEMAND_DAYS_DEFAULT, limit: DEMAND_LIMIT_DEFAULT });
    expect(parseDemandParams({ days: "abc" }).days).toBe(DEMAND_DAYS_DEFAULT);
  });
  it("клампінг у межі", () => {
    expect(parseDemandParams({ days: "1000" }).days).toBe(365);
    expect(parseDemandParams({ days: "0" }).days).toBe(1);
    expect(parseDemandParams({ limit: "999" }).limit).toBe(100);
  });
  it("приймає валідні числа/рядки", () => {
    expect(parseDemandParams({ days: "7", limit: "50" })).toEqual({ days: 7, limit: 50 });
  });
});

describe("noResultsShare", () => {
  it("частка або 0 при відсутності запитів", () => {
    expect(noResultsShare(3, 12)).toBe(0.25);
    expect(noResultsShare(0, 0)).toBe(0);
  });
});
