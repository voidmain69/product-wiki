import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { fromJsonLd } from "./cascade.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8");

describe("fromJsonLd — детермінований рівень екстракції", () => {
  it("витягує повний товар з schema.org/Product", () => {
    const draft = fromJsonLd(fixture("product-jsonld.html"));
    expect(draft).not.toBeNull();
    expect(draft!.name).toBe("RoboVac X40");
    // brand як вкладений об'єкт { name } має розгортатись у рядок
    expect(draft!.brand).toBe("ExampleTech");
    expect(draft!.mpn).toBe("RVX40-EU");
    expect(draft!.gtin).toBe("4820000123456");
    expect(draft!.categoryRaw).toEqual(["Роботи-пилососи"]);
  });

  it("зберігає сирі атрибути з одиницями (для нормалізатора)", () => {
    const draft = fromJsonLd(fixture("product-jsonld.html"))!;
    expect(draft.attributesRaw).toContainEqual({ key: "Вага нетто", value: "3,2", unit: "кг" });
    expect(draft.attributesRaw).toContainEqual({ key: "Рівень шуму", value: "55", unit: "дБ" });
    expect(draft.attributesRaw).toHaveLength(3);
  });

  it("мапить зображення й опис", () => {
    const draft = fromJsonLd(fixture("product-jsonld.html"))!;
    expect(draft.media).toHaveLength(2);
    expect(draft.media[0]).toEqual({
      type: "image",
      url: "https://example-manufacturer.com/img/rvx40-1.jpg",
    });
    expect(draft.descriptions[0]?.section).toBe("overview");
    expect(draft.descriptions[0]?.text).toContain("LiDAR");
  });

  it("знаходить Product усередині @graph і масиву @type", () => {
    const draft = fromJsonLd(fixture("product-graph.html"));
    expect(draft).not.toBeNull();
    expect(draft!.name).toBe("SilentVac Mini");
    expect(draft!.brand).toBe("ExampleTech");
    expect(draft!.gtin).toBe("4820000999999");
  });

  it("реальна розмітка (Logitech): mpn з вкладеного model[], не топ-рівня", () => {
    // регресія на реальний кейс: виробники кладуть ідентифікатори в model[]/offers[]
    const draft = fromJsonLd(fixture("product-real-logitech.html"));
    expect(draft).not.toBeNull();
    expect(draft!.name).toContain("MX Master 3S");
    expect(draft!.brand).toBe("Logitech");
    expect(draft!.mpn).toBe("910-007500"); // з model[0].mpn
    expect(draft!.media.length).toBeGreaterThan(0);
  });

  it("зрізає дубльований бренд із назви (ASUS-кейс), не чіпаючи бренд-підрядок", () => {
    const mk = (name: string, brand: string) =>
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name,
        brand,
      })}</script>`;

    // бренд дублюється як префікс → зрізаємо
    expect(fromJsonLd(mk("ASUS TUF Gaming A15 (2024)", "ASUS"))!.name).toBe(
      "TUF Gaming A15 (2024)",
    );
    expect(fromJsonLd(mk("ASUS TUF Gaming A15 (2024)", "ASUS"))!.brand).toBe("ASUS");

    // бренд — частина слова (межа слова не збігається) → не чіпаємо
    expect(fromJsonLd(mk("ASUSTeK Router", "ASUS"))!.name).toBe("ASUSTeK Router");

    // назва не починається з бренду → без змін
    expect(fromJsonLd(mk("MX Master 3S", "Logitech"))!.name).toBe("MX Master 3S");

    // назва дорівнює бренду → не віддаємо порожнє ім'я
    expect(fromJsonLd(mk("ASUS", "ASUS"))!.name).toBe("ASUS");
  });

  it("повертає null, коли на сторінці немає Product", () => {
    expect(fromJsonLd("<html><body><h1>Про компанію</h1></body></html>")).toBeNull();
  });

  it("не падає на битому JSON-LD", () => {
    const html = `<script type="application/ld+json">{ broken json }</script>`;
    expect(fromJsonLd(html)).toBeNull();
  });
});
