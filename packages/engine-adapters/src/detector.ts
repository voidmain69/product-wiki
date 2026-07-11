import type { ProbeData } from "./types.js";
import type { EngineType } from "@wiki/contracts";

/**
 * Евристики детекції рушія за результатом дешевого зондування.
 * Повертають підказку; фінальне рішення — за max(probe()) серед адаптерів.
 * Мета: не запускати дорогий браузер там, де вистачає static HTTP.
 */

const SPA_MARKERS = [
  /<div id="__next"/i, // Next.js
  /<div id="__nuxt"/i, // Nuxt
  /ng-version=/i, // Angular
  /<div id="root">\s*<\/div>/i, // порожній React root
  /<div id="app">\s*<\/div>/i, // порожній Vue root
  /window\.__NUXT__/i,
  /window\.__APOLLO_STATE__/i,
];

const STRUCTURED_MARKERS = [
  /application\/ld\+json/i, // JSON-LD
  /itemtype="https?:\/\/schema\.org\/Product"/i, // мікродані Product
];

export interface DetectionHint {
  engine: EngineType;
  confidence: number;
  reason: string;
}

export function detectEngine(probe: ProbeData): DetectionHint {
  const ct = probe.contentType.toLowerCase();
  const html = probe.htmlSample;

  if (ct.includes("application/pdf")) {
    return { engine: "document", confidence: 0.95, reason: "content-type pdf" };
  }

  const hasStructured = STRUCTURED_MARKERS.some((r) => r.test(html));
  const looksSpa = SPA_MARKERS.some((r) => r.test(html));

  // Є JSON-LD/мікродані у первинному HTML → static вистачить (найдешевше).
  if (hasStructured && !isEmptyBody(html)) {
    return { engine: "static", confidence: 0.9, reason: "structured data in initial HTML" };
  }

  // Порожній контейнер SPA або відомі маркери → потрібен рендер.
  if (looksSpa || isEmptyBody(html)) {
    return { engine: "headless", confidence: 0.75, reason: "SPA markers / empty body" };
  }

  // Дефолт: пробуємо static, extractor вирішить, чи достатньо даних.
  return { engine: "static", confidence: 0.5, reason: "default" };
}

/** Тіло вважається "порожнім", якщо в ньому обмаль текстового контенту між тегами. */
function isEmptyBody(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;
  const textLen = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim().length;
  return textLen < 200;
}
