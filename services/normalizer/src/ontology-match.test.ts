import { describe, it, expect } from "vitest";
import { matchLabel, topCandidates, l2normalize, type LabelVec } from "./ontology-match.js";
import { OntologyVecCache } from "./ontology-embed.js";

/* Детерміновані «ембединги»: близькі вектори = dense-кандидати (шортліст). */
const VECS: Record<string, number[]> = {
  вага: [1, 0, 0],
  Weight: [0.99, 0.02, 0], // майже колінеарний до «вага»
  висота: [0.9, 0.44, 0], // dense-близький до «вага» (тверда пастка — різні атрибути)
  потужність: [0, 1, 0],
  Power: [0.02, 0.99, 0],
  Розмір: [0.9, 0.3, 0], // dense-близький до «вага», але НЕ синонім (rerank має відкинути)
  Загадка: [0, 0, 1], // ортогональний — нема відповідника
};
const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => VECS[t] ?? [0, 0, 0]);

/* Fake rerank: справжній синонім → високий скор, інше → низький (імітує cross-encoder). */
const SYN: Record<string, string> = { Weight: "вага", Power: "потужність" };
const fakeRerank = async (query: string, docs: string[]): Promise<{ index: number; score: number }[]> =>
  docs
    .map((d, index) => ({ index, score: SYN[query] === d ? 0.99 : 0.01 }))
    .sort((a, b) => b.score - a.score);

describe("matchLabel / topCandidates — dense-логіка", () => {
  const index: LabelVec[] = [
    { key: "weight_net", label: "вага", vec: l2normalize(VECS["вага"]!) },
    { key: "power", label: "потужність", vec: l2normalize(VECS["потужність"]!) },
  ];

  it("dense-only matchLabel: вектор вище порога → ключ", () => {
    const m = matchLabel(l2normalize(VECS["Weight"]!), index, 0.92);
    expect(m?.key).toBe("weight_net");
  });

  it("topCandidates повертає шортліст за спаданням із floor", () => {
    const cands = topCandidates(l2normalize(VECS["Weight"]!), index, 8, 0.65);
    expect(cands[0]?.entry.key).toBe("weight_net");
    expect(cands.every((c) => c.sim >= 0.65)).toBe(true);
  });

  it("порожній індекс → нема кандидатів", () => {
    expect(topCandidates(l2normalize(VECS["вага"]!), [], 8, 0.65)).toEqual([]);
  });
});

describe("OntologyVecCache — двоступенево (dense-шортліст → rerank-гейт)", () => {
  const labels = [
    { key: "weight_net", label: "вага" },
    { key: "height", label: "висота" },
    { key: "power", label: "потужність" },
  ];

  it("rerank підтверджує справжній синонім (Weight→вага), відкидає dense-пастку (висота)", async () => {
    const cache = new OntologyVecCache(fakeEmbed, fakeRerank, { denseFloor: 0.65, rerankThreshold: 0.5 });
    await cache.init(labels);
    // «Weight» dense-близький і до «вага», і до «висота» (обидва в шортлісті),
    // але rerank підтверджує лише «вага».
    const m = await cache.match("Weight");
    expect(m?.key).toBe("weight_net");
  });

  it("rerank нижче порога → null (авто-провіжн), навіть якщо dense-кандидати є", async () => {
    const cache = new OntologyVecCache(fakeEmbed, fakeRerank, { denseFloor: 0.65, rerankThreshold: 0.5 });
    await cache.init(labels);
    // «Розмір» dense-близький до «вага» (потрапляє в шортліст), але rerank не підтвердить.
    expect(await cache.match("Розмір")).toBeNull();
  });

  it("нема dense-кандидатів → null без виклику rerank", async () => {
    const cache = new OntologyVecCache(fakeEmbed, fakeRerank, { denseFloor: 0.65, rerankThreshold: 0.5 });
    await cache.init(labels);
    expect(await cache.match("Загадка")).toBeNull();
  });

  it("dense-only фолбек (rerank не ін'єктовано) з консервативним порогом", async () => {
    const cache = new OntologyVecCache(fakeEmbed, null, { denseFloor: 0.65, denseOnlyThreshold: 0.92 });
    await cache.init(labels);
    expect((await cache.match("Weight"))?.key).toBe("weight_net");
  });

  it("ML кидає помилку → деградація: init не валиться, match повертає null", async () => {
    const throwing = async (): Promise<number[][]> => {
      throw new Error("ML down");
    };
    const cache = new OntologyVecCache(throwing, fakeRerank);
    await cache.init(labels); // не має кидати
    expect(cache.enabled).toBe(false);
    expect(await cache.match("Weight")).toBeNull();
  });

  it("add() інкрементально доембеджує новий ключ для наступних матчів", async () => {
    const cache = new OntologyVecCache(fakeEmbed, fakeRerank, { denseFloor: 0.65, rerankThreshold: 0.5 });
    await cache.init([{ key: "power", label: "потужність" }]);
    expect(await cache.match("Weight")).toBeNull(); // «вага» ще нема в індексі
    await cache.add("weight_net", "вага");
    expect((await cache.match("Weight"))?.key).toBe("weight_net");
  });
});
