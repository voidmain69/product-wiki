/**
 * Чистий парсер robots.txt (без I/O) — щоб логіку можна було юніт-тестувати
 * без мережі. Redis-кешований шлюз, що це використовує, — у robots.ts.
 *
 * Коректний за де-факто стандартом:
 *  - групуємо правила за user-agent; беремо групу нашого UA або "*";
 *  - Allow/Disallow з префіксним матчем, перемагає найдовше правило
 *    (за рівної довжини — Allow, як у специфікації);
 *  - порожній/відсутній robots.txt → дозволено все.
 */

export interface RobotRule {
  type: "allow" | "disallow";
  path: string;
}

/** Парсить robots.txt у список правил для конкретного user-agent (+ група "*"). */
export function parseRobots(text: string, userAgent: string): RobotRule[] {
  const uaToken = userAgent.toLowerCase().split("/")[0] ?? userAgent.toLowerCase();
  const groups = new Map<string, RobotRule[]>();
  let currentAgents: string[] = [];
  let sawRuleForCurrent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // новий блок user-agent (кілька поспіль формують спільну групу)
      if (sawRuleForCurrent) {
        currentAgents = [];
        sawRuleForCurrent = false;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
    } else if (field === "allow" || field === "disallow") {
      sawRuleForCurrent = true;
      for (const agent of currentAgents) {
        groups.get(agent)!.push({ type: field, path: value });
      }
    }
  }

  // специфічний UA має пріоритет над "*"
  return groups.get(uaToken) ?? groups.get("*") ?? [];
}

/** Чи дозволений шлях за набором правил (найдовший префікс перемагає; tie → allow). */
export function isPathAllowed(rules: RobotRule[], path: string): boolean {
  let best: { rule: RobotRule; len: number } | null = null;
  for (const rule of rules) {
    if (rule.path === "") continue; // "Disallow:" (порожньо) = дозволити все
    if (path.startsWith(rule.path)) {
      if (
        !best ||
        rule.path.length > best.len ||
        (rule.path.length === best.len && rule.type === "allow")
      ) {
        best = { rule, len: rule.path.length };
      }
    }
  }
  return best ? best.rule.type === "allow" : true;
}
