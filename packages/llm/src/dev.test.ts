import { describe, it, expect } from "vitest";
import { z } from "zod";
import { DevLLMProvider, classifyIntent } from "./dev.js";
import { buildAnswerMessages, SYSTEM_INTENT } from "./prompts.js";
import type { RetrievedChunk } from "@wiki/contracts";

describe("classifyIntent — детермінований роутинг", () => {
  it("порівняльний запит → compare + виділені назви", () => {
    const r = classifyIntent("ЗАПИТ: порівняй RoboVac X40 і SilentVac Mini");
    expect(r.intent).toBe("compare");
    expect(r.filters.productNames?.length).toBeGreaterThanOrEqual(2);
  });

  it("запит на підбір → recommend", () => {
    expect(classifyIntent("ЗАПИТ: порадь тихий пилосос для квартири").intent).toBe("recommend");
  });

  it("питання про характеристику → info", () => {
    expect(classifyIntent("ЗАПИТ: яка вага RoboVac X40?").intent).toBe("info");
  });

  it("привітання/офтоп → out_of_scope", () => {
    expect(classifyIntent("ЗАПИТ: привіт, як справи?").intent).toBe("out_of_scope");
  });
});

describe("DevLLMProvider", () => {
  const llm = new DevLLMProvider();

  it("generateStructured задовольняє схему intent", async () => {
    const schema = z.object({
      intent: z.enum(["info", "recommend", "compare", "followup", "out_of_scope"]),
      searchQuery: z.string(),
      filters: z.object({ productNames: z.array(z.string()).optional() }),
    });
    const out = await llm.generateStructured(
      [{ role: "system", content: SYSTEM_INTENT }, { role: "user", content: "ЗАПИТ: порадь пилосос" }],
      schema,
    );
    expect(out.intent).toBe("recommend");
  });

  it("відповідь будується лише з КОНТЕКСТУ і несе маркери [n]", async () => {
    const chunks: RetrievedChunk[] = [
      { chunkId: "c1", productId: "p1", chunkType: "overview", text: "RoboVac X40 тихий робот-пилосос.", score: 1, sourceUrls: ["https://m.example/p/x40"] },
      { chunkId: "c2", productId: "p1", chunkType: "spec_group", text: "Рівень шуму 55 дБ.", score: 0.8, sourceUrls: ["https://m.example/p/x40"] },
    ];
    const answer = await llm.generate(buildAnswerMessages("розкажи про товар", chunks));
    expect(answer).toContain("[1]");
    expect(answer).toContain("[2]");
    expect(answer).toContain("виробника");
  });

  it("немає контексту → чесна відмова", async () => {
    const answer = await llm.generate(buildAnswerMessages("щось", []));
    expect(answer.toLowerCase()).toContain("немає даних");
  });

  it("stream віддає ті самі токени, що й generate", async () => {
    const msgs = buildAnswerMessages("розкажи", [
      { chunkId: "c1", productId: "p1", chunkType: "overview", text: "Тихий пилосос.", score: 1, sourceUrls: ["https://m.example/p"] },
    ]);
    let streamed = "";
    for await (const t of llm.stream(msgs)) streamed += t;
    expect(streamed).toBe(await llm.generate(msgs));
  });
});
