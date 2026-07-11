import { describe, it, expect } from "vitest";
import { parseRobots, isPathAllowed } from "./robots-parser.js";

const UA = "ProductWikiBot/0.1 (+https://example/bot)";

describe("parseRobots — вибір групи за user-agent", () => {
  it("бере правила з групи '*', коли специфічного UA немає", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\n", UA);
    expect(rules).toEqual([{ type: "disallow", path: "/private" }]);
  });

  it("специфічний UA має пріоритет над '*'", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: productwikibot",
      "Allow: /products",
      "Disallow: /internal",
    ].join("\n");
    const rules = parseRobots(txt, UA);
    expect(rules).toContainEqual({ type: "allow", path: "/products" });
    expect(rules).toContainEqual({ type: "disallow", path: "/internal" });
    expect(rules).not.toContainEqual({ type: "disallow", path: "/" });
  });

  it("ігнорує коментарі та порожні рядки", () => {
    const rules = parseRobots("# comment\nUser-agent: *\n\nDisallow: /x # inline\n", UA);
    expect(rules).toEqual([{ type: "disallow", path: "/x" }]);
  });
});

describe("isPathAllowed — найдовший префікс перемагає", () => {
  const rules = [
    { type: "disallow" as const, path: "/products" },
    { type: "allow" as const, path: "/products/public" },
  ];

  it("забороняє шлях під загальним Disallow", () => {
    expect(isPathAllowed(rules, "/products/secret")).toBe(false);
  });

  it("дозволяє шлях під довшим Allow", () => {
    expect(isPathAllowed(rules, "/products/public/item-1")).toBe(true);
  });

  it("порожній Disallow не блокує нічого", () => {
    expect(isPathAllowed([{ type: "disallow", path: "" }], "/anything")).toBe(true);
  });

  it("без правил → дозволено", () => {
    expect(isPathAllowed([], "/products/x40")).toBe(true);
  });

  it("за рівної довжини перемагає Allow", () => {
    const tie = [
      { type: "disallow" as const, path: "/a" },
      { type: "allow" as const, path: "/a" },
    ];
    expect(isPathAllowed(tie, "/a/b")).toBe(true);
  });
});
