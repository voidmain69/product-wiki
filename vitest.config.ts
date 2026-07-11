import { defineConfig } from "vitest/config";

/**
 * Єдина конфігурація тестів для всього монорепо. Тести колокуються з кодом
 * (`*.test.ts`) поряд із модулем, що тестується. Vitest резолвить TS-джерела
 * пакетів `@wiki/*` через workspace-симлінки й мапить ESM `.js`-імпорти на `.ts`.
 */
export default defineConfig({
  test: {
    include: ["{packages,services,apps}/**/src/**/*.test.ts"],
    environment: "node",
    globals: false, // явні імпорти з "vitest" — без глобалів (чисто для eslint)
    passWithNoTests: false,
  },
});
