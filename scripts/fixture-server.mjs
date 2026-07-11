/**
 * Локальний fixture-сайт «виробника» для E2E-прогону ingest без зовнішньої мережі.
 * Віддає robots.txt (дозволяє все), sitemap.xml і сторінки товарів з JSON-LD
 * (schema.org/Product) — тому екстракція йде детермінованим шляхом БЕЗ LLM.
 *
 * Запуск standalone:  node scripts/fixture-server.mjs [port]
 * Або як модуль:       import { startFixtureServer } from "./fixture-server.mjs"
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PRODUCTS = [
  {
    slug: "robovac-x40",
    name: "RoboVac X40",
    gtin: "4820000123401",
    mpn: "RVX40-EU",
    description: "Робот-пилосос RoboVac X40 з LiDAR-навігацією для квартир до 200 м².",
    attrs: [
      { name: "Вага нетто", value: "3,2", unit: "кг" },
      { name: "Потужність", value: "60", unit: "Вт" },
      { name: "Рівень шуму", value: "55", unit: "дБ" },
      { name: "Ємність акумулятора", value: "5200", unit: "mAh" },
    ],
  },
  {
    slug: "silentvac-mini",
    name: "SilentVac Mini",
    gtin: "4820000123402",
    mpn: "SVM-EU",
    description: "Компактний тихий робот-пилосос для малих квартир.",
    attrs: [
      { name: "Вага нетто", value: "2,4", unit: "кг" },
      { name: "Потужність", value: "45", unit: "Вт" },
      { name: "Рівень шуму", value: "48", unit: "дБ" },
      { name: "Ємність акумулятора", value: "3200", unit: "mAh" },
    ],
  },
];

function productHtml(origin, p) {
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    brand: { "@type": "Brand", name: "FixtureTech" },
    mpn: p.mpn,
    gtin13: p.gtin,
    category: "Роботи-пилососи",
    image: [`${origin}/img/${p.slug}.jpg`],
    description: p.description,
    additionalProperty: p.attrs.map((a) => ({
      "@type": "PropertyValue",
      name: a.name,
      value: a.value,
      unitText: a.unit,
    })),
  };
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>${p.name}</title>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
</head><body><h1>${p.name}</h1><p>${p.description}</p></body></html>`;
}

export function startFixtureServer(port = 4599) {
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(req.url, origin);
    const path = url.pathname;

    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
      return;
    }
    if (path === "/sitemap.xml") {
      const urls = PRODUCTS.map((p) => `<url><loc>${origin}/products/${p.slug}</loc></url>`).join("");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset>${urls}</urlset>`);
      return;
    }
    const m = path.match(/^\/products\/([^/]+)$/);
    if (m) {
      const p = PRODUCTS.find((x) => x.slug === m[1]);
      if (p) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(productHtml(origin, p));
        return;
      }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`fixture-server: http://127.0.0.1:${port} (${PRODUCTS.length} products)`);
      resolve(server);
    });
  });
}

export const FIXTURE_BRAND = "FixtureTech";
export const FIXTURE_PRODUCT_COUNT = PRODUCTS.length;

// standalone-режим (коректне порівняння URL на всіх ОС)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFixtureServer(Number(process.argv[2]) || 4599);
}
