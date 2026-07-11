import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Єдиний flat-config для всього монорепо. Правила доповнюють (не дублюють)
 * scripts/check-arch.mjs: гвард тримає межі шарів, eslint — якість коду.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/migrations/**",
      "**/.venv/**", // python venv (vendored JS у site-packages)
      "**/next-env.d.ts", // згенерований Next.js
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts}"],
    rules: {
      // інваріант: без any на межах — контракти валідуються zod-ом
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      // консольний лог у воркерах — норма (структуроване логування — TODO Фази 2)
      "no-console": "off",
      "eqeqeq": ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    // .mjs — прості node-скрипти (tooling/конфіги); node-глобали, без TS-строгості
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        TextDecoder: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
