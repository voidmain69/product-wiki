import { describe, it, expect } from "vitest";
import { normalizeValue } from "./units.js";

describe("normalizeValue — канонізація одиниць до SI", () => {
  it("десяткова кома → крапка, кирилична одиниця → SI", () => {
    expect(normalizeValue("2,5 кг")).toEqual({ value: 2.5, unit: "kg" });
  });

  it("конвертує грами в кілограми", () => {
    expect(normalizeValue("2500 g")).toEqual({ value: 2.5, unit: "kg" });
  });

  it("конвертує фунти в кілограми з округленням до 3 знаків", () => {
    expect(normalizeValue("5.5 lbs")).toEqual({ value: 2.495, unit: "kg" });
  });

  it("кіловати → вати", () => {
    expect(normalizeValue("1,4 кВт")).toEqual({ value: 1400, unit: "W" });
  });

  it("зберігає dB і mAh без конвертації", () => {
    expect(normalizeValue("55 дБ")).toEqual({ value: 55, unit: "dB" });
    expect(normalizeValue("5200 mAh")).toEqual({ value: 5200, unit: "mAh" });
  });

  it("невідома одиниця → число + одиниця як є", () => {
    expect(normalizeValue("3 шт")).toEqual({ value: 3, unit: "шт" });
  });

  it("нечислове значення лишається рядком без одиниці", () => {
    expect(normalizeValue("чорний")).toEqual({ value: "чорний", unit: null });
  });

  it("unitHint застосовується, коли одиниці немає в рядку", () => {
    expect(normalizeValue("3.2", "кг")).toEqual({ value: 3.2, unit: "kg" });
  });

  it("одиниця в рядку має пріоритет над hint", () => {
    expect(normalizeValue("2.5 kg", "g")).toEqual({ value: 2.5, unit: "kg" });
  });
});
