import { describe, it, expect } from "vitest";
import { extractLinks, sameHost, routeLinks } from "./bfs.js";

describe("extractLinks", () => {
  it("резолвить відносні, відкидає fragment і невалідні", () => {
    const html = `<a href="/p/1">a</a> <a href='https://ex.com/p/2'>b</a> <a href="#top">c</a> <a href="mailto:x">d</a>`;
    expect(extractLinks(html, "https://ex.com/cat")).toEqual([
      "https://ex.com/p/1",
      "https://ex.com/p/2",
      "mailto:x", // валідний URL, відсіється пізніше sameHost
    ]);
  });
});

describe("sameHost", () => {
  it("ігнорує www., відкидає зовнішні", () => {
    expect(sameHost("https://www.ex.com/x", ["ex.com"])).toBe(true);
    expect(sameHost("https://ex.com/x", ["www.ex.com"])).toBe(true);
    expect(sameHost("https://evil.com/x", ["ex.com"])).toBe(false);
    expect(sameHost("not-a-url", ["ex.com"])).toBe(false);
  });
});

describe("routeLinks", () => {
  const patterns = [/\/p\/\d+/];
  const domains = ["ex.com"];
  const html = `
    <a href="/p/1">товар</a>
    <a href="/p/2">товар</a>
    <a href="/category/monitors">каталог</a>
    <a href="https://other.com/p/9">зовнішній</a>
    <a href="/about">про</a>`;

  it("товарні за urlPatterns, каталожні — той самий хост у межах глибини", () => {
    const r = routeLinks(html, "https://ex.com/c", patterns, domains, 0, 3);
    expect(r.products.sort()).toEqual(["https://ex.com/p/1", "https://ex.com/p/2"]);
    expect(r.listings.sort()).toEqual(["https://ex.com/about", "https://ex.com/category/monitors"]);
  });

  it("на максимальній глибині каталожні не додаються (лише товарні)", () => {
    const r = routeLinks(html, "https://ex.com/c", patterns, domains, 3, 3);
    expect(r.products.sort()).toEqual(["https://ex.com/p/1", "https://ex.com/p/2"]);
    expect(r.listings).toEqual([]);
  });

  it("зовнішні хости завжди відкидаються", () => {
    const r = routeLinks(html, "https://ex.com/c", patterns, domains, 0, 3);
    expect(r.products).not.toContain("https://other.com/p/9");
  });
});
