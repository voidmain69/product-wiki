import { describe, it, expect } from "vitest";
import { parseListParams, totalPages, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT } from "./products-query.js";

describe("parseListParams — розбір параметрів каталогу", () => {
  it("дефолти на порожньому вводі", () => {
    const p = parseListParams({});
    expect(p).toMatchObject({ q: undefined, brand: undefined, category: undefined, sort: "updated", limit: LIST_LIMIT_DEFAULT, page: 1, offset: 0 });
  });

  it("трімить рядки; порожні стають undefined", () => {
    const p = parseListParams({ q: "  дриль  ", brand: "  ", category: "Пилки" });
    expect(p.q).toBe("дриль");
    expect(p.brand).toBeUndefined();
    expect(p.category).toBe("Пилки");
  });

  it("санітизує sort до дозволеного набору", () => {
    expect(parseListParams({ sort: "name" }).sort).toBe("name");
    expect(parseListParams({ sort: "brand" }).sort).toBe("brand");
    expect(parseListParams({ sort: "price" }).sort).toBe("updated"); // невідоме → дефолт
  });

  it("клампить limit у [1, MAX] і рахує offset зі сторінки", () => {
    expect(parseListParams({ limit: "999" }).limit).toBe(LIST_LIMIT_MAX);
    expect(parseListParams({ limit: "0" }).limit).toBe(1);
    expect(parseListParams({ limit: "abc" }).limit).toBe(LIST_LIMIT_DEFAULT);
    const p3 = parseListParams({ page: "3", limit: "10" });
    expect(p3.page).toBe(3);
    expect(p3.offset).toBe(20); // (3-1)*10
  });

  it("page не менше 1 навіть на сміттєвому вводі", () => {
    expect(parseListParams({ page: "-5" }).page).toBe(1);
    expect(parseListParams({ page: "0" }).page).toBe(1);
    expect(parseListParams({ page: "xyz" }).page).toBe(1);
  });
});

describe("totalPages", () => {
  it("округлює вгору, мінімум 1", () => {
    expect(totalPages(0, 24)).toBe(1);
    expect(totalPages(24, 24)).toBe(1);
    expect(totalPages(25, 24)).toBe(2);
    expect(totalPages(200, 24)).toBe(9);
  });
});
