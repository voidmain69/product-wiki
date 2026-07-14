import { describe, it, expect } from "vitest";
import { resolveAttrs, type AttrRow } from "./snapshot-attrs.js";

const row = (attrKey: string, valueCanonical: unknown, sourceSnapshotId: string): AttrRow => ({
  attrKey,
  valueCanonical,
  unitCanonical: null,
  valueRaw: String(valueCanonical),
  sourceSnapshotId,
});

const dates = new Map<string, Date>([
  ["s-old", new Date("2026-01-01")],
  ["s-new", new Date("2026-06-01")],
]);

describe("resolveAttrs", () => {
  it("унікальні ключі — усі лишаються, 0 конфліктів", () => {
    const r = resolveAttrs([row("weight", 5, "s-old"), row("panel", "IPS", "s-old")], dates);
    expect(r.conflicts).toBe(0);
    expect(r.attributes.map((a) => a.key).sort()).toEqual(["panel", "weight"]);
  });

  it("той самий ключ, однакове значення з двох джерел — 1 рядок, 0 конфліктів", () => {
    const r = resolveAttrs([row("panel", "IPS", "s-old"), row("panel", "ips", "s-new")], dates);
    expect(r.conflicts).toBe(0);
    expect(r.attributes).toHaveLength(1);
  });

  it("конфлікт значень — беремо найсвіжіше, conflicts=1", () => {
    const r = resolveAttrs([row("refresh", 144, "s-old"), row("refresh", 165, "s-new")], dates);
    expect(r.conflicts).toBe(1);
    expect(r.attributes).toHaveLength(1);
    expect(r.attributes[0]!.valueCanonical).toBe(165); // s-new новіший
  });

  it("порядок рядків не впливає — найсвіжіше однаково виграє", () => {
    const r = resolveAttrs([row("refresh", 165, "s-new"), row("refresh", 144, "s-old")], dates);
    expect(r.attributes[0]!.valueCanonical).toBe(165);
    expect(r.conflicts).toBe(1);
  });

  it("невідома дата снапшота → трактується як найстаріша", () => {
    const r = resolveAttrs([row("x", "a", "s-new"), row("x", "b", "s-missing")], dates);
    expect(r.attributes[0]!.valueCanonical).toBe("a"); // s-new має дату, s-missing → epoch
  });
});
