import { describe, it, expect } from "vitest";
import { normalizeBrand, normalizeCategoryPath } from "./taxonomy.js";

describe("normalizeBrand — суб-бренди → материнський", () => {
  it("зводить Avent/Fidelio/Evnia до Philips", () => {
    expect(normalizeBrand("Avent")).toBe("Philips");
    expect(normalizeBrand("Philips Fidelio")).toBe("Philips");
    expect(normalizeBrand("Evnia")).toBe("Philips");
  });
  it("невідомий бренд — без змін (тільки trim)", () => {
    expect(normalizeBrand("ASUS")).toBe("ASUS");
    expect(normalizeBrand("  Logitech ")).toBe("Logitech");
  });
});

describe("normalizeCategoryPath", () => {
  it("розбиває композити на кому", () => {
    expect(normalizeCategoryPath(["Монітори, настільні ПК"])).toEqual(["Монітори", "Настільні ПК"]);
    expect(normalizeCategoryPath(["Системи контролю за дитиною, термометри"])).toEqual([
      "Системи контролю за дитиною",
      "Термометри",
    ]);
  });

  it("прибирає ASUS-серії (це лінії, не категорії)", () => {
    expect(normalizeCategoryPath(["Монітори", "ProArt"])).toEqual(["Монітори"]);
    expect(normalizeCategoryPath(["TUF Gaming"])).toEqual([]);
    expect(normalizeCategoryPath(["ZenScreen", "Eye Care"])).toEqual([]);
  });

  it("прибирає шум (Deals7, Для дому)", () => {
    expect(normalizeCategoryPath(["Deals7"])).toEqual([]);
    expect(normalizeCategoryPath(["Телевізори", "Для дому"])).toEqual(["Телевізори"]);
  });

  it("НЕ розбиває на «/» (Аудіо/відео — одна категорія)", () => {
    expect(normalizeCategoryPath(["Аудіо/відео-аксесуари"])).toEqual(["Аудіо/відео-аксесуари"]);
  });

  it("дедуплікує й капіталізує", () => {
    expect(normalizeCategoryPath(["монітори", "Монітори"])).toEqual(["Монітори"]);
  });

  it("порожнє/невалідне → []", () => {
    expect(normalizeCategoryPath([])).toEqual([]);
    expect(normalizeCategoryPath(null)).toEqual([]);
    expect(normalizeCategoryPath(["", "  "])).toEqual([]);
  });
});
