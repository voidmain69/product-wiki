import { describe, it, expect } from "vitest";
import type { Product } from "@wiki/contracts";
import { buildChunks } from "./chunker.js";

const prov = {
  sourceId: "s1",
  snapshotRef: "snap1",
  url: "https://example-manufacturer.com/products/robovac-x40",
  fetchedAt: "2026-01-01T00:00:00.000Z",
};

const product: Product = {
  id: "p1",
  revisionId: "r1",
  brand: "ExampleTech",
  name: "RoboVac X40",
  mpn: "RVX40-EU",
  gtin: "4820000123456",
  categoryId: "c1",
  categoryPath: ["Побутова техніка", "Пилососи", "Роботи-пилососи"],
  attributes: [
    { key: "noise_db", valueCanonical: 55, unitCanonical: "dB", valueRaw: "55", provenance: prov },
    { key: "weight_net", valueCanonical: 3.2, unitCanonical: "kg", valueRaw: "3,2", provenance: prov },
  ],
  texts: [
    { section: "overview", text: "Тихий робот-пилосос.", lang: "uk", provenance: prov },
    { section: "features", text: "LiDAR-навігація та мапування.", lang: "uk", provenance: prov },
  ],
  media: [],
  sources: [prov],
  status: "active",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("buildChunks — типізований чанкінг товару", () => {
  it("будує overview, spec_group і feature-чанки", () => {
    const chunks = buildChunks(product);
    const types = chunks.map((c) => c.chunkType);
    expect(types).toContain("overview");
    expect(types).toContain("spec_group");
    expect(types).toContain("feature");
    expect(types).not.toContain("usecase"); // без usecaseText
  });

  it("overview містить бренд, назву і шлях категорії", () => {
    const overview = buildChunks(product).find((c) => c.chunkType === "overview")!;
    expect(overview.text).toContain("ExampleTech");
    expect(overview.text).toContain("RoboVac X40");
    expect(overview.text).toContain("Роботи-пилососи");
  });

  it("spec_group серіалізує атрибути з сирими значеннями", () => {
    const spec = buildChunks(product).find((c) => c.chunkType === "spec_group")!;
    expect(spec.text).toContain("noise_db: 55 dB");
    expect(spec.text).toContain("weight_net: 3,2 kg");
  });

  it("payload несе фільтровані атрибути й джерела для цитат", () => {
    const chunk = buildChunks(product)[0]!;
    expect(chunk.payload.brand).toBe("ExampleTech");
    expect(chunk.payload.attrs).toEqual({ noise_db: 55, weight_net: 3.2 });
    expect(chunk.payload.sourceUrls).toEqual([prov.url]);
  });

  it("usecase-чанк додається лише за наявності згенерованого тексту", () => {
    const chunks = buildChunks(product, "Підходить для квартир до 200 м² з тваринами.");
    const usecase = chunks.find((c) => c.chunkType === "usecase");
    expect(usecase).toBeDefined();
    expect(usecase!.text).toContain("200 м²");
  });

  it("id чанка стабільний: productId:type:ordinal", () => {
    const overview = buildChunks(product).find((c) => c.chunkType === "overview")!;
    expect(overview.id).toBe("p1:overview:0");
  });
});
