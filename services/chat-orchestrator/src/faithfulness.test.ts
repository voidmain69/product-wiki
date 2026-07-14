import { describe, it, expect } from "vitest";
import { scoreFaithfulness } from "./faithfulness.js";

describe("scoreFaithfulness", () => {
  it("усі числа заземлені → score 1", () => {
    const ctx = "Частота оновлення 165 Гц. Вага 2.5 кг. Ємність 20000 mAh.";
    const r = scoreFaithfulness("Дисплей 165 Гц [1], важить 2,5 кг [1].", ctx);
    expect(r.numbersTotal).toBe(2);
    expect(r.numbersGrounded).toBe(2);
    expect(r.score).toBe(1);
    expect(r.ungrounded).toEqual([]);
  });

  it("тисячні з пробілом і кома-десяткова матчаться попри форматування", () => {
    const r = scoreFaithfulness("Акумулятор 20 000 mAh, вага 2,5 кг.", "20000 mAh; 2.5 kg");
    expect(r.score).toBe(1);
  });

  it("незаземлене число знижує score і потрапляє в ungrounded", () => {
    const r = scoreFaithfulness("Частота 240 Гц.", "Частота оновлення 165 Гц.");
    expect(r.numbersTotal).toBe(1);
    expect(r.numbersGrounded).toBe(0);
    expect(r.score).toBe(0);
    expect(r.ungrounded).toEqual(["240"]);
  });

  it("маркери цитат [n] не рахуються за факти", () => {
    const r = scoreFaithfulness("Гарний вибір [1][2][3].", "будь-який контекст без чисел");
    expect(r.numbersTotal).toBe(0);
    expect(r.score).toBe(1);
  });

  it("без чисел у відповіді → score 1 (нема чого вигадувати)", () => {
    expect(scoreFaithfulness("Це тихий і компактний пристрій.", "").score).toBe(1);
  });

  it("частковий: 2 з 3 заземлені", () => {
    const r = scoreFaithfulness("165 Гц, 1 мс, 400 ніт.", "165 Гц, час відгуку 1 мс");
    expect(r.numbersTotal).toBe(3);
    expect(r.numbersGrounded).toBe(2);
    expect(r.score).toBeCloseTo(2 / 3, 5);
    expect(r.ungrounded).toEqual(["400"]);
  });

  it("дедуплікує повтори числа у відповіді", () => {
    const r = scoreFaithfulness("165 Гц і ще раз 165 Гц.", "165 Гц");
    expect(r.numbersTotal).toBe(1);
    expect(r.score).toBe(1);
  });
});
