/**
 * Faithfulness-метрика відповіді чату (інваріант 7 «чат не вигадує»). Детермінована, без
 * LLM: перевіряємо ЧИСЛА — найризикованішу поверхню галюцинацій у spec-RAG (числа мають
 * братися зі structured-атрибутів у retrieved-контексті). Кожне число з відповіді має
 * зустрічатись у цитованому контексті; score = grounded / total.
 *
 * Свідомо НЕ ловимо текстові твердження (потребували б LLM-судді) — числа дають дешевий,
 * детермінований, найінформативніший сигнал. Маркери цитат [n] ігноруємо (це не факти).
 * Відомі обмеження: бюджет із запиту («до 15000 грн»), що не в контексті, порахується як
 * незаземлений; діапазони через кому-пробіл можуть дати зайве число. Це сигнал, не гейт.
 */

export interface FaithfulnessResult {
  /** Унікальних числових токенів у відповіді. */
  numbersTotal: number;
  /** Скільки з них знайдено в контексті. */
  numbersGrounded: number;
  /** grounded / total; 1.0 коли чисел немає (нема чого вигадувати). */
  score: number;
  /** Канонічні числа з відповіді, яких немає в контексті. */
  ungrounded: string[];
}

const CITATION = /\[\d+\]/g;

/**
 * Канонічні числа з тексту: об'єднує тисячні з пробілом (JS `\s` покриває і NBSP),
 * десятковий роздільник (крапка/кома) → число. Маркери цитат прибираємо.
 */
function canonNumbers(text: string): string[] {
  // «[1]» не має рахуватись за факт «1»
  let t = text.replace(CITATION, " ");
  // тисячні з пробілом: «20 000» → «20000» (\s покриває звичайний пробіл і NBSP)
  t = t.replace(/(\d)\s(?=\d{3}(?:\D|$))/g, "$1");
  const out: string[] = [];
  for (const m of t.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = Number(m[0].replace(",", "."));
    if (!Number.isNaN(n)) out.push(String(n));
  }
  return out;
}

/**
 * Оцінює заземленість чисел відповіді в цитованому контексті. `context` — конкатенація
 * тексту цитованих чанків (містить і спец-значення). Дедуплікуємо числа відповіді, щоб
 * повтор одного факту не роздував знаменник.
 */
export function scoreFaithfulness(answer: string, context: string): FaithfulnessResult {
  const ctx = new Set(canonNumbers(context));
  const uniqAns = [...new Set(canonNumbers(answer))];
  const ungrounded = uniqAns.filter((n) => !ctx.has(n));
  const grounded = uniqAns.length - ungrounded.length;
  return {
    numbersTotal: uniqAns.length,
    numbersGrounded: grounded,
    score: uniqAns.length === 0 ? 1 : grounded / uniqAns.length,
    ungrounded,
  };
}
