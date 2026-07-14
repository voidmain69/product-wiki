import { describe, it, expect } from "vitest";
import { isProductPage, hasJsonLdProduct, hasMicrodataProduct, hasOgProduct } from "./classify.js";

describe("isProductPage — структуровані маркери", () => {
  it("JSON-LD Product (рядок і масив типів)", () => {
    expect(hasJsonLdProduct(`<script type="application/ld+json">{"@type":"Product","name":"X"}</script>`)).toBe(true);
    expect(hasJsonLdProduct(`{"@type": ["Product", "Offer"]}`)).toBe(true);
    expect(isProductPage(`{"@type":"Product"}`)).toBe(true);
  });

  it("microdata schema.org/Product (http і https)", () => {
    expect(hasMicrodataProduct(`<div itemscope itemtype="https://schema.org/Product">`)).toBe(true);
    expect(hasMicrodataProduct(`<div itemtype='http://schema.org/Product'>`)).toBe(true);
  });

  it("og:type product (обидва порядки атрибутів, product.item)", () => {
    expect(hasOgProduct(`<meta property="og:type" content="product">`)).toBe(true);
    expect(hasOgProduct(`<meta content="product.item" property="og:type">`)).toBe(true);
  });

  it("категорійна/довільна сторінка → false (без ASUS-хардкоду)", () => {
    expect(isProductPage(`<html><body><table class="rowTableTitle">...</table></body></html>`)).toBe(false);
    expect(isProductPage(`<meta property="og:type" content="website">`)).toBe(false);
    expect(isProductPage(`{"@type":"ItemList"}`)).toBe(false);
    expect(isProductPage(``)).toBe(false);
  });
});
