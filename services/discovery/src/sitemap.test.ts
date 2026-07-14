import { describe, it, expect } from "vitest";
import { parseSitemapXml } from "./sitemap.js";

describe("parseSitemapXml", () => {
  it("плоский urlset — loc + lastmod", () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://ex.com/p/1</loc><lastmod>2026-01-02</lastmod></url>
        <url><loc>https://ex.com/p/2</loc></url>
      </urlset>`;
    const r = parseSitemapXml(xml);
    expect(r.nested).toEqual([]);
    expect(r.entries).toEqual([
      { loc: "https://ex.com/p/1", lastmod: "2026-01-02" },
      { loc: "https://ex.com/p/2" },
    ]);
  });

  it("sitemapindex — повертає nested, entries порожні", () => {
    const xml = `<sitemapindex xmlns="...">
      <sitemap><loc>https://ex.com/sitemap-1.xml</loc><lastmod>2026-01-01</lastmod></sitemap>
      <sitemap><loc>https://ex.com/sitemap-2.xml</loc></sitemap>
    </sitemapindex>`;
    const r = parseSitemapXml(xml);
    expect(r.entries).toEqual([]);
    expect(r.nested).toEqual(["https://ex.com/sitemap-1.xml", "https://ex.com/sitemap-2.xml"]);
  });

  it("декодує XML-сутності в URL", () => {
    const xml = `<urlset><url><loc>https://ex.com/p?a=1&amp;b=2</loc></url></urlset>`;
    expect(parseSitemapXml(xml).entries[0]!.loc).toBe("https://ex.com/p?a=1&b=2");
  });

  it("фолбек на голі <loc> без обгортки <url>", () => {
    const xml = `<urlset><loc>https://ex.com/a</loc><loc>https://ex.com/b</loc></urlset>`;
    expect(parseSitemapXml(xml).entries.map((e) => e.loc)).toEqual(["https://ex.com/a", "https://ex.com/b"]);
  });

  it("порожній/сміття → нічого", () => {
    expect(parseSitemapXml("")).toEqual({ entries: [], nested: [] });
    expect(parseSitemapXml("<html></html>")).toEqual({ entries: [], nested: [] });
  });
});
