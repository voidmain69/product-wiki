import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { fromJsonLd, fromApiPayloads, fromSectionSpecTable } from "./cascade.js";

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

describe("fromApiPayloads — рівень 2: Philips PRX .specification", () => {
  const prx = (chapters: unknown) => [
    { requestUrl: "https://www.philips.ua/prx/product/B2C/uk_UA/CONSUMER/products/HR3660_55.specification", method: "GET", status: 200, body: { success: true, data: { csChapter: chapters } } },
  ];

  it("розгортає csChapter→csItem→csValue у пари атрибутів", () => {
    const attrs = fromApiPayloads(
      prx([
        { csChapterName: "Технічні характеристики", csItem: [{ csItemName: "Ємність пляшки", csValue: [{ csValueName: "0,6 л" }] }] },
        { csChapterName: "Покриття", csItem: [{ csItemName: "Матеріал чаші", csValue: [{ csValueName: "Пластик" }] }] },
      ]),
    );
    expect(attrs).toContainEqual({ key: "Ємність пляшки", value: "0,6 л" });
    expect(attrs).toContainEqual({ key: "Матеріал чаші", value: "Пластик" });
  });

  it("зливає кілька значень одного атрибута через кому", () => {
    const attrs = fromApiPayloads(
      prx([{ csChapterName: "Загальні", csItem: [{ csItemName: "Кольори", csValue: [{ csValueName: "Чорний" }, { csValueName: "Сірий" }] }] }]),
    );
    expect(attrs).toContainEqual({ key: "Кольори", value: "Чорний, Сірий" });
  });

  it("дедуплікує повторні мітки й ігнорує порожні значення", () => {
    const attrs = fromApiPayloads(
      prx([
        { csItem: [{ csItemName: "Вага", csValue: [{ csValueName: "1 кг" }] }, { csItemName: "Вага", csValue: [{ csValueName: "2 кг" }] }] },
        { csItem: [{ csItemName: "Порожнє", csValue: [{ csValueName: "" }] }] },
      ]),
    );
    expect(attrs.filter((a) => a.key === "Вага")).toHaveLength(1);
    expect(attrs.find((a) => a.key === "Порожнє")).toBeUndefined();
  });

  it("повертає [] на чужих/порожніх payload-ах", () => {
    expect(fromApiPayloads([])).toEqual([]);
    expect(fromApiPayloads([{ body: { unrelated: true } }])).toEqual([]);
    expect(fromApiPayloads([null, { nope: 1 }])).toEqual([]);
  });
});

describe("fromSectionSpecTable — рівень 3: секційна spec-таблиця (Kärcher)", () => {
  const karcher = `
    <div data-anchor="Опис"><table class="table"><tr><td>не</td><td>спека</td></tr></table></div>
    <div data-anchor="Специфікації">
      <h3>Технічні характеристики</h3>
      <table class="table">
        <tr><td>Напруга   (В)</td><td>
          220 - 240 </td></tr>
        <tr><td>Частота (Гц)</td><td>50 - 60</td></tr>
        <tr><td>Тиск (бар/МПа)</td><td>20 - макс. 110 / 2 - макс. 11</td></tr>
      </table>
    </div>`;

  it("витягує пари td[0]/td[1] лише зі спец-секції, згортаючи пробіли", () => {
    const attrs = fromSectionSpecTable(karcher);
    expect(attrs).toContainEqual({ key: "Напруга (В)", value: "220 - 240" });
    expect(attrs).toContainEqual({ key: "Частота (Гц)", value: "50 - 60" });
    expect(attrs).toHaveLength(3);
    // таблиця із секції "Опис" не потрапляє
    expect(attrs.find((a) => a.key === "не")).toBeUndefined();
  });

  it("повертає [] коли спец-секції нема або пар мало", () => {
    expect(fromSectionSpecTable("<div><table><tr><td>a</td><td>b</td></tr></table></div>")).toEqual([]);
    expect(
      fromSectionSpecTable(`<div data-anchor="Специфікації"><table><tr><td>k</td><td>v</td></tr></table></div>`),
    ).toEqual([]); // лише 1 пара (<3)
  });
});
