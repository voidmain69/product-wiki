/**
 * Нормалізація значень атрибутів до канонічної форми + одиниці. Детермінована,
 * без LLM (інваріант 7). Обробляє:
 *   • HTML-ентіті («&gt;10» → «>10»);
 *   • булеве («Так»/«Ні»/«Yes»/«No» → true/false);
 *   • число + одиниця з конверсією в SI-подібну канонічну («2,5 кг» → {2.5, kg});
 *   • «голе» число + unit-хінт ключа онтології («0,18» @kg → {0.18, kg});
 *   • префікси до/макс/мін/≤/≥ («< 0,15 Вт» → {0.15, W}).
 * Діапазони («20–20000») і габарити («950 x 765») лишаємо рядком — це структурні
 * випадки для окремого етапу (щоб не втратити семантику в скалярному полі).
 * Невідома одиниця → лишаємо токен як є; нечислове → рядок.
 */
export interface Normalized {
  value: number | string | boolean;
  unit: string | null;
}

const TO_SI: Record<string, { unit: string; factor: number }> = {
  // маса → kg
  kg: { unit: "kg", factor: 1 }, кг: { unit: "kg", factor: 1 },
  g: { unit: "kg", factor: 0.001 }, г: { unit: "kg", factor: 0.001 },
  mg: { unit: "kg", factor: 1e-6 }, мг: { unit: "kg", factor: 1e-6 },
  lbs: { unit: "kg", factor: 0.453592 }, lb: { unit: "kg", factor: 0.453592 },
  oz: { unit: "kg", factor: 0.0283495 },
  // потужність → W
  w: { unit: "W", factor: 1 }, вт: { unit: "W", factor: 1 },
  kw: { unit: "W", factor: 1000 }, квт: { unit: "W", factor: 1000 },
  mw: { unit: "W", factor: 0.001 }, мвт: { unit: "W", factor: 0.001 },
  // енергія → Wh
  wh: { unit: "Wh", factor: 1 }, kwh: { unit: "Wh", factor: 1000 },
  // звук → dB
  db: { unit: "dB", factor: 1 }, дб: { unit: "dB", factor: 1 },
  // заряд → mAh
  mah: { unit: "mAh", factor: 1 }, ah: { unit: "mAh", factor: 1000 },
  мАг: { unit: "mAh", factor: 1 }, магод: { unit: "mAh", factor: 1 },
  // опір → Ω, час → h/min
  ом: { unit: "Ω", factor: 1 }, ohm: { unit: "Ω", factor: 1 },
  h: { unit: "h", factor: 1 }, год: { unit: "h", factor: 1 }, hr: { unit: "h", factor: 1 }, hour: { unit: "h", factor: 1 },
  min: { unit: "min", factor: 1 }, хв: { unit: "min", factor: 1 }, хвилин: { unit: "min", factor: 1 },
  s: { unit: "s", factor: 1 }, sec: { unit: "s", factor: 1 }, secs: { unit: "s", factor: 1 }, сек: { unit: "s", factor: 1 },
  day: { unit: "h", factor: 24 }, days: { unit: "h", factor: 24 }, дн: { unit: "h", factor: 24 }, днів: { unit: "h", factor: 24 },
  // довжина → mm
  mm: { unit: "mm", factor: 1 }, мм: { unit: "mm", factor: 1 },
  cm: { unit: "mm", factor: 10 }, см: { unit: "mm", factor: 10 },
  m: { unit: "mm", factor: 1000 }, м: { unit: "mm", factor: 1000 },
  nm: { unit: "nm", factor: 1 }, нм: { unit: "nm", factor: 1 },
  ft: { unit: "mm", factor: 304.8 }, feet: { unit: "mm", factor: 304.8 }, foot: { unit: "mm", factor: 304.8 },
  // діагональ дисплея → inch (не конвертуємо в мм — це усталена одиниця показу)
  in: { unit: "inch", factor: 1 }, inch: { unit: "inch", factor: 1 }, inches: { unit: "inch", factor: 1 },
  '″': { unit: "inch", factor: 1 }, '"': { unit: "inch", factor: 1 },
  дюйм: { unit: "inch", factor: 1 }, дюйма: { unit: "inch", factor: 1 }, дюймів: { unit: "inch", factor: 1 },
  // частота → Hz
  hz: { unit: "Hz", factor: 1 }, гц: { unit: "Hz", factor: 1 },
  khz: { unit: "Hz", factor: 1e3 }, кгц: { unit: "Hz", factor: 1e3 },
  mhz: { unit: "Hz", factor: 1e6 }, мгц: { unit: "Hz", factor: 1e6 },
  ghz: { unit: "Hz", factor: 1e9 }, ггц: { unit: "Hz", factor: 1e9 },
  // час → ms
  ms: { unit: "ms", factor: 1 }, мс: { unit: "ms", factor: 1 },
  // напруга → V, струм → mA
  v: { unit: "V", factor: 1 }, в: { unit: "V", factor: 1 },
  mv: { unit: "V", factor: 0.001 }, мв: { unit: "V", factor: 0.001 },
  ma: { unit: "mA", factor: 1 }, ма: { unit: "mA", factor: 1 },
  a: { unit: "mA", factor: 1000 }, а: { unit: "mA", factor: 1000 },
  // памʼять → GB
  gb: { unit: "GB", factor: 1 }, гб: { unit: "GB", factor: 1 },
  mb: { unit: "GB", factor: 1 / 1024 }, мб: { unit: "GB", factor: 1 / 1024 },
  tb: { unit: "GB", factor: 1024 }, тб: { unit: "GB", factor: 1024 },
  // обʼєм → L
  l: { unit: "L", factor: 1 }, л: { unit: "L", factor: 1 },
  ml: { unit: "L", factor: 0.001 }, мл: { unit: "L", factor: 0.001 },
  gal: { unit: "L", factor: 3.785 },
  // кут → °
  "°": { unit: "°", factor: 1 }, deg: { unit: "°", factor: 1 }, град: { unit: "°", factor: 1 },
  // спец-одиниці без конверсії (щоб число не втрачало одиницю): роздільність / оберти
  dpi: { unit: "dpi", factor: 1 }, rpm: { unit: "rpm", factor: 1 },
  // TODO: температура °C/°F — афінна конверсія (не factor-модель), окремим етапом
};

// Булеве — ТОЧНИЙ збіг слова (JS `\b` не працює з кирилицею), щоб «Німеччина» ≠ «Ні».
function asBool(s: string): boolean | null {
  const t = s.toLowerCase().replace(/[.,!]+$/, "").trim();
  if (/^(так|yes|true|є|наявн(ий|а|е|і)?|підтримується|присутн(ій|я)?|✓)$/u.test(t)) return true;
  if (/^(ні|no|немає|відсутн(ій|я|є)?|false|не підтримується)$/u.test(t)) return false;
  return null;
}

// «число + одиниця» має бути ВСІМ рядком (з опційним префіксом) — інакше «10 в комплекті»
// хибно дасть 10 V. Зайвий текст → лишаємо рядком (структурний випадок).
const SCALAR = /^\s*(?:[<>≤≥~]|up\s+to|до|макс\.?|мін\.?|max|min|approx\.?|about|прибл\.?|близько|≈)?\s*(-?\d[\d\s]*(?:[.,]\d+)?)\s*([%°″"'a-zа-яіїєґ]{1,6}\.?)?\s*$/i;

/** Розкодовує базові HTML-ентіті, що протікають з екстракції (&gt; &lt; &amp; &quot; &#nn;). */
function decodeEntities(s: string): string {
  return s
    .replace(/&gt;/gi, ">").replace(/&lt;/gi, "<").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function normalizeValue(raw: string, unitHint?: string): Normalized {
  const s = decodeEntities(String(raw)).trim();
  if (!s) return { value: raw, unit: null };

  if (s.length <= 24) {
    const b = asBool(s);
    if (b !== null) return { value: b, unit: null };
  }

  // діапазони (a–b, a~b, a/b) і габарити (a x b) — структурні, лишаємо рядком
  const core = s.replace(/[%°″"'a-zа-яіїєґ.\s]+$/i, "");
  if (/\d[\s]*[xх×][\s]*\d/i.test(s) || /\d[\s]*[–—~/][\s]*\d/.test(core)) {
    return { value: s, unit: null };
  }

  const m = s.match(SCALAR);
  if (!m || !m[1]) return { value: s, unit: null };

  const num = Number(m[1].replace(/[\s]/g, "").replace(",", "."));
  if (Number.isNaN(num)) return { value: s, unit: null };

  const token = (m[2] ?? "").toLowerCase().replace(/\.$/, "");
  const hint = (unitHint ?? "").toLowerCase();

  // юніт з рядка має пріоритет над хінтом ключа; хінт — лише для «голого» числа
  if (token) {
    const conv = TO_SI[token];
    return conv
      ? { value: round(num * conv.factor), unit: conv.unit }
      : { value: num, unit: token };
  }
  if (!hint || hint === "count") return { value: num, unit: null }; // count — безрозмірний
  const conv = TO_SI[hint];
  return conv ? { value: round(num * conv.factor), unit: conv.unit } : { value: num, unit: hint };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Евристика unit-хінта за міткою атрибута — для «голих» чисел, де одиниця відома з
 * КЛЮЧА, а не з рядка (напр. «Вага виробу» → kg, «Ширина» → mm, «Кількість портів» →
 * count). Повертає токен, який normalizeValue приймає як unitHint; null = невідомо.
 * Використовується normalizer-воркером при авто-провіжні онтології та скриптами BC.
 */
export function guessUnit(label: string): string | null {
  const l = label.toLowerCase();
  const has = (re: RegExp) => re.test(l);
  if (has(/кількіст|к-сть|number of|роз['’]?ємів|портів|\bшт\b/)) return "count";
  if (has(/діагонал.*дюйм|у дюймах|diagonal.*inch|\(дюйм/)) return "inch";
  if (has(/вага|маса\b|weight/) && !has(/клас|індекс|розподіл/)) return "kg";
  if (has(/ширина|висота|глибина|довжина|діаметр|товщина|width|height|depth|length|diameter|thickness/) && !has(/екран|дисплей|піксел/)) return "mm";
  if (has(/потужн|power|споживана|енергоспож/) && !has(/клас|рівень|режим/)) return "W";
  if (has(/напруг|voltage/)) return "V";
  if (has(/(^|\W)струм|current\b/)) return "mA";
  if (has(/ємніст.*акум|battery.*capacit|mah/)) return "mAh";
  if (has(/\bdpi\b|tracking resolution|роздільн.*сенсор/)) return "dpi";
  if (has(/battery life|runtime|play\s?time|talk\s?time|charg(e|ing)\s?time|час роботи|автономн/)) return "h";
  if (has(/wireless range|operating distance|радіус дії|дальність/)) return "m";
  if (has(/частот|frequency|оновлення|refresh|такт/)) return "Hz";
  if (has(/час відгук|response time|затримк|latency/)) return "ms";
  if (has(/обсяг.*пам|storage|накопичув|\bгб\b|\bgb\b|\bтб\b|\btb\b/)) return "GB";
  if (has(/рівень шуму|noise|звуков.*тиск/)) return "dB";
  if (has(/кут|angle|огляд/)) return "°";
  if (has(/обсяг.*(літр|\(л\))|ємніст.*(літр|\(л\))|volume.*(l\)|litre)/)) return "L";
  return null;
}
