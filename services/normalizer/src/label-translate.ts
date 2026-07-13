/**
 * Переклад міток атрибутів у КАНОНІЧНУ мову (українська) ПЕРЕД матчингом онтології.
 *
 * Навіщо: емпірично BGE-M3 dense + bge-reranker-v2-m3 зводять синоніми лише В МЕЖАХ
 * однієї мови (UK↔UK rerank ~0.99), але НЕ крос-мовно (EN «Weight» ↔ UK «Вага нетто»
 * rerank ~0.001 — нижче гейта). Тож мітку не-укр джерела спершу перекладаємо українською,
 * і вже переклад матчимо/аліасимо на наявний укр-ключ. Оригінальну мітку зберігаємо як alias.
 *
 * Це резолюція МЕТАданих (ключ онтології), не значень — інваріанти 6/7 (LLM не вигадує
 * значень) не порушуються, як і з ембединг-матчингом. `translate` ін'єктується (прод — LLM,
 * тести — фейк). Best-effort: помилка LLM → мітка лишається мовою джерела (як до цього).
 */
export type TranslateFn = (text: string) => Promise<string>;

export class LabelTranslator {
  private readonly cache = new Map<string, string>();
  private disabled = false;

  constructor(
    private readonly translate: TranslateFn | null,
    private readonly target = "uk",
  ) {}

  /**
   * Мітку мови `lang` → цільова мова (кешовано за міткою). Повертає ОРИГІНАЛ, якщо:
   * немає translate / вимкнено після помилки / мова вже цільова (або невідома) / порожня.
   */
  async toCanonical(label: string, lang?: string | null): Promise<string> {
    const l = (lang ?? "").toLowerCase();
    const trimmed = label.trim();
    if (!this.translate || this.disabled || !trimmed || !l || l.startsWith(this.target)) return label;

    const ck = trimmed.toLowerCase();
    const cached = this.cache.get(ck);
    if (cached !== undefined) return cached;

    try {
      const out = clean(await this.translate(trimmed)) || label;
      this.cache.set(ck, out);
      return out;
    } catch {
      if (!this.disabled) {
        this.disabled = true;
        console.warn("label-translate: LLM недоступний — переклад міток вимкнено (лишаються мовою джерела)");
      }
      return label;
    }
  }
}

/** Чистить LLM-відповідь: перший рядок, без лапок/крапки, обмежена довжина. */
function clean(s: string): string {
  const first = s.trim().split(/\r?\n/)[0] ?? "";
  return first
    .replace(/^["'«»\s]+/, "")
    .replace(/["'«».\s]+$/, "")
    .slice(0, 120)
    .trim();
}
