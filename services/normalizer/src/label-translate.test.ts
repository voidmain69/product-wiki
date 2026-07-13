import { describe, it, expect, vi } from "vitest";
import { LabelTranslator } from "./label-translate.js";

describe("LabelTranslator — переклад міток у канонічну мову (uk) перед матчингом", () => {
  it("uk/порожня/невідома мова → без перекладу (translate не викликається)", async () => {
    const fn = vi.fn(async () => "Х");
    const t = new LabelTranslator(fn);
    expect(await t.toCanonical("Вага", "uk")).toBe("Вага");
    expect(await t.toCanonical("Вага", "uk-UA")).toBe("Вага");
    expect(await t.toCanonical("Weight", null)).toBe("Weight");
    expect(await t.toCanonical("Weight", "")).toBe("Weight");
    expect(fn).not.toHaveBeenCalled();
  });

  it("не-uk мітку перекладає через ін'єктований translate", async () => {
    const t = new LabelTranslator(async (s) => (s === "Weight" ? "Вага" : "Висота"));
    expect(await t.toCanonical("Weight", "en")).toBe("Вага");
    expect(await t.toCanonical("Height", "en")).toBe("Висота");
  });

  it("кешує за міткою (повторний виклик не б'є LLM)", async () => {
    const fn = vi.fn(async () => "Вага");
    const t = new LabelTranslator(fn);
    await t.toCanonical("Weight", "en");
    await t.toCanonical("weight", "en"); // регістр — той самий ключ кешу
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("чистить відповідь LLM: перший рядок, без лапок/крапки", async () => {
    const t = new LabelTranslator(async () => '"Вага нетто".\nПояснення...');
    expect(await t.toCanonical("Net weight", "en")).toBe("Вага нетто");
  });

  it("порожній переклад → повертає оригінал", async () => {
    const t = new LabelTranslator(async () => "   ");
    expect(await t.toCanonical("Weight", "en")).toBe("Weight");
  });

  it("помилка LLM → graceful: оригінал, і надалі переклад вимкнено", async () => {
    const fn = vi.fn(async () => { throw new Error("LLM down"); });
    const t = new LabelTranslator(fn);
    expect(await t.toCanonical("Weight", "en")).toBe("Weight");
    expect(await t.toCanonical("Height", "en")).toBe("Height"); // вимкнено — без повторних спроб
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("translate=null → завжди оригінал (деградація до поточної поведінки)", async () => {
    const t = new LabelTranslator(null);
    expect(await t.toCanonical("Weight", "en")).toBe("Weight");
  });
});
