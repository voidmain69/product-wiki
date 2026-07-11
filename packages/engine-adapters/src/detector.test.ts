import { describe, it, expect } from "vitest";
import { detectEngine } from "./detector.js";
import type { ProbeData } from "./types.js";

const probe = (over: Partial<ProbeData>): ProbeData => ({
  status: 200,
  contentType: "text/html",
  headers: {},
  htmlSample: "",
  ...over,
});

const filledBody = (inner: string) =>
  `<html><body>${inner}${"текстовий контент сторінки виробника ".repeat(20)}</body></html>`;

describe("detectEngine — вибір рушія за дешевим зондуванням", () => {
  it("PDF за content-type → document", () => {
    const hint = detectEngine(probe({ contentType: "application/pdf" }));
    expect(hint.engine).toBe("document");
    expect(hint.confidence).toBeGreaterThan(0.9);
  });

  it("JSON-LD у повному HTML → static (найдешевший шлях)", () => {
    const html = filledBody(
      `<script type="application/ld+json">{"@type":"Product"}</script>`,
    );
    const hint = detectEngine(probe({ htmlSample: html }));
    expect(hint.engine).toBe("static");
    expect(hint.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("JSON-LD з тонким body → static (структуровані дані > обсяг тексту)", () => {
    // реальний кейс SSR-сторінки виробника: повний JSON-LD, мінімум видимого тексту
    const html = `<html><body><h1>X</h1><script type="application/ld+json">{"@type":"Product"}</script></body></html>`;
    expect(detectEngine(probe({ htmlSample: html })).engine).toBe("static");
  });

  it("порожній React-root → headless (потрібен рендер)", () => {
    const html = `<html><body><div id="root"></div></body></html>`;
    const hint = detectEngine(probe({ htmlSample: html }));
    expect(hint.engine).toBe("headless");
  });

  it("маркер Next.js → headless", () => {
    const html = `<html><body><div id="__next"></div></body></html>`;
    expect(detectEngine(probe({ htmlSample: html })).engine).toBe("headless");
  });

  it("звичайний HTML без структурованих даних → static за замовчуванням", () => {
    const html = filledBody("<h1>Товар</h1><p>Опис без JSON-LD.</p>");
    const hint = detectEngine(probe({ htmlSample: html }));
    expect(hint.engine).toBe("static");
  });
});
