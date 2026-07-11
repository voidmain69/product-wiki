import type { Product, ProductChunk } from "@wiki/contracts";

/**
 * Doc Builder: перетворює канонічний товар у типізовані чанки, що ПОВАЖАЮТЬ
 * структуру товару (не сліпий split по 512 токенів). Типи:
 *   overview | spec_group | feature | usecase.
 * usecase-чанк генерується LLM один раз (тут — місток; виклик у main.ts),
 * бо саме він з'єднує мову потреб користувача з мовою специфікацій.
 */
export function buildChunks(product: Product, usecaseText?: string): ProductChunk[] {
  const chunks: ProductChunk[] = [];
  const sourceUrls = product.sources.map((s) => s.url);
  const attrsPayload: Record<string, number | string | boolean> = {};
  for (const a of product.attributes) {
    if (typeof a.valueCanonical !== "object") attrsPayload[a.key] = a.valueCanonical;
  }
  const basePayload = {
    brand: product.brand,
    categoryPath: product.categoryPath,
    attrs: attrsPayload,
    sourceUrls,
  };
  let ord = 0;
  const push = (type: ProductChunk["chunkType"], text: string) => {
    chunks.push({
      id: `${product.id}:${type}:${ord}`,
      productId: product.id,
      revisionId: product.revisionId,
      chunkType: type,
      ordinal: ord++,
      text,
      payload: basePayload,
    });
  };

  // 1. overview
  const overview = product.texts.find((t) => t.section === "overview")?.text ?? "";
  push("overview", `${product.brand} ${product.name}. Категорія: ${product.categoryPath.join(" / ")}. ${overview}`.trim());

  // 2. spec_group — атрибути, серіалізовані в природну мову
  ord = 0;
  const specSentences = product.attributes.map(
    (a) => `${a.key}: ${a.valueRaw}${a.unitCanonical ? " " + a.unitCanonical : ""}.`,
  );
  if (specSentences.length) push("spec_group", `Характеристики ${product.name}: ${specSentences.join(" ")}`);

  // 3. feature — маркетингові/функціональні розділи
  ord = 0;
  for (const t of product.texts.filter((t) => t.section !== "overview")) {
    push("feature", t.text);
  }

  // 4. usecase — згенерований LLM (для рекомендаційних запитів)
  ord = 0;
  if (usecaseText) push("usecase", usecaseText);

  return chunks;
}
