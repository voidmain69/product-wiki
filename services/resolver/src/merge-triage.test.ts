import { describe, it, expect } from "vitest";
import {
  identifierConflict,
  attrConflictStats,
  cosine,
  triageDecision,
  TRIAGE_APPROVE_COSINE,
  TRIAGE_REJECT_CONFLICTS,
} from "./merge-triage.js";

describe("identifierConflict", () => {
  it("різні непорожні MPN → конфлікт", () => {
    expect(identifierConflict({ mpn: "PA278QV" }, { mpn: "PA279CV" })).toBe(true);
  });
  it("різні GTIN → конфлікт", () => {
    expect(identifierConflict({ gtin: "1234567890123" }, { gtin: "9999999999999" })).toBe(true);
  });
  it("однаковий MPN (регістр/пробіли) → без конфлікту", () => {
    expect(identifierConflict({ mpn: " pa278qv " }, { mpn: "PA278QV" })).toBe(false);
  });
  it("відсутній ідентифікатор в одного боку → без конфлікту (мовчання ≠ заперечення)", () => {
    expect(identifierConflict({ mpn: null }, { mpn: "PA278QV" })).toBe(false);
    expect(identifierConflict({}, {})).toBe(false);
  });
});

describe("attrConflictStats", () => {
  it("рахує збіги й конфлікти лише за спільними ключами", () => {
    const left = [
      { key: "diagonal", value: 27 },
      { key: "panel", value: "IPS" },
      { key: "refresh", value: 165 },
      { key: "weight", value: 5.2 },
    ];
    const right = [
      { key: "diagonal", value: 27 }, // збіг
      { key: "panel", value: "va" }, // конфлікт
      { key: "refresh", value: 144 }, // конфлікт
      { key: "ports", value: 3 }, // лише праворуч — ігнор
    ];
    expect(attrConflictStats(left, right)).toEqual({ agreeing: 1, conflicting: 2 });
  });
  it("рядки порівнює без регістру/пробілів; числа з ε", () => {
    const s = attrConflictStats([{ key: "p", value: "IPS" }, { key: "n", value: 60 }], [{ key: "p", value: " ips " }, { key: "n", value: 60.0000000001 }]);
    expect(s).toEqual({ agreeing: 2, conflicting: 0 });
  });
});

describe("cosine", () => {
  it("тотожні вектори → 1", () => {
    expect(cosine([1, 0, 1], [1, 0, 1])).toBeCloseTo(1, 6);
  });
  it("ортогональні → 0; різна довжина/нуль → 0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("triageDecision", () => {
  const base = { identifierConflict: false, conflictingAttrs: 0, agreeingAttrs: 5, nameCosine: 0.99 };

  it("конфлікт ідентифікаторів → reject (навіть при високому cos)", () => {
    expect(triageDecision({ ...base, identifierConflict: true }).verdict).toBe("reject");
  });
  it("≥поріг конфліктних атрибутів → reject", () => {
    expect(triageDecision({ ...base, conflictingAttrs: TRIAGE_REJECT_CONFLICTS, nameCosine: 0.99 }).verdict).toBe("reject");
  });
  it("високий cos + 0 конфліктів → approve", () => {
    expect(triageDecision({ ...base, nameCosine: TRIAGE_APPROVE_COSINE }).verdict).toBe("approve");
  });
  it("високий cos, але є конфлікт (нижче порога reject) → human", () => {
    expect(triageDecision({ ...base, conflictingAttrs: 1, nameCosine: 0.99 }).verdict).toBe("human");
  });
  it("низький cos, без конфліктів → human", () => {
    expect(triageDecision({ ...base, nameCosine: 0.7 }).verdict).toBe("human");
  });
});
