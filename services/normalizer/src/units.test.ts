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

describe("normalizeValue — розширений парсер (BC)", () => {
  it("«голе» число + unit-хінт ключа (найбільший кейс — 41k значень)", () => {
    expect(normalizeValue("0,18", "kg")).toEqual({ value: 0.18, unit: "kg" });
    expect(normalizeValue("1008", "mm")).toEqual({ value: 1008, unit: "mm" });
    expect(normalizeValue("75", "inch")).toEqual({ value: 75, unit: "inch" });
  });

  it("хінт «count» → безрозмірне число (порти/кількість)", () => {
    expect(normalizeValue("2", "count")).toEqual({ value: 2, unit: null });
  });

  it("булеве: Так/Ні/Yes/No → true/false", () => {
    expect(normalizeValue("Так")).toEqual({ value: true, unit: null });
    expect(normalizeValue("Ні")).toEqual({ value: false, unit: null });
    expect(normalizeValue("No")).toEqual({ value: false, unit: null });
    expect(normalizeValue("Немає")).toEqual({ value: false, unit: null });
  });

  it("HTML-ентіті декодуються (&gt; &amp; &quot;)", () => {
    expect(normalizeValue("&gt; 10")).toEqual({ value: 10, unit: null });
    expect(normalizeValue("&gt;10 Вт")).toEqual({ value: 10, unit: "W" });
  });

  it("префікс до/макс/мін/≤ ігнорується, число+одиниця беруться", () => {
    expect(normalizeValue("< 0,15 Вт")).toEqual({ value: 0.15, unit: "W" });
    expect(normalizeValue("до 360")).toEqual({ value: 360, unit: null });
    expect(normalizeValue("макс. 110 Вт")).toEqual({ value: 110, unit: "W" });
  });

  it("пробіл-роздільник тисяч прибирається", () => {
    expect(normalizeValue("1 008,5 мм")).toEqual({ value: 1008.5, unit: "mm" });
  });

  it("діапазони й габарити лишаються рядком (структурний етап окремо)", () => {
    expect(normalizeValue("20–20000")).toEqual({ value: "20–20000", unit: null });
    expect(normalizeValue("100–240 В")).toEqual({ value: "100–240 В", unit: null });
    expect(normalizeValue("50/60 Гц")).toEqual({ value: "50/60 Гц", unit: null });
    expect(normalizeValue("950 x 765 x 660 мм")).toEqual({ value: "950 x 765 x 660 мм", unit: null });
  });

  it("число з зайвим текстом → рядок (не хибний юніт: «10 в комплекті» ≠ 10 V)", () => {
    expect(normalizeValue("10 в комплекті")).toEqual({ value: "10 в комплекті", unit: null });
  });

  it("дюйми та кут", () => {
    expect(normalizeValue("27 дюймів")).toEqual({ value: 27, unit: "inch" });
    expect(normalizeValue("178 °")).toEqual({ value: 178, unit: "°" });
  });
});
