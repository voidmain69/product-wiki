#!/usr/bin/env node
/**
 * Гвард архітектури монорепо. Zero-deps (лише node:*), тому працює навіть без
 * `pnpm install`. Перевіряє правила з CLAUDE.md / ARCHITECTURE.md:
 *
 *   L1. packages/contracts не імпортує нічого внутрішнього (@wiki/*).
 *   L2. Інші packages/* імпортують з внутрішнього лише @wiki/contracts.
 *   L3. services/* не імпортують інші services/* (спілкування — лише через події).
 *   L4. apps/web імпортує з внутрішнього лише @wiki/contracts.
 *   L5. apps/api не імпортує services/*, окрім @wiki/chat-orchestrator (бібліотека RAG).
 *
 *   A1. "nats" — лише в packages/events (шину не обходити).
 *   A2. "postgres" (драйвер) — лише в packages/db.
 *   A3. "minio" — лише в packages/storage.
 *   A4. "playwright" — лише в packages/engine-adapters.
 *   A5. Deep-імпорти @wiki/x/src/... та @wiki/x/dist/... заборонені.
 *
 *   C1. Відносні імпорти в ESM-пакетах закінчуються на .js (окрім apps/web).
 *   C2. Внутрішні залежності в package.json — лише "workspace:*".
 *   C3. Кожен src/main.ts у services обробляє SIGTERM.
 *
 * Використання: node scripts/check-arch.mjs [--quiet]
 * Exit code: 0 — чисто, 2 — є порушення (список у stderr).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const QUIET = process.argv.includes("--quiet");

/* ── збір файлів ─────────────────────────────────────────────────────── */

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "migrations", "volumes"]);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const allFiles = walk(ROOT);
const tsFiles = allFiles.filter((f) => /\.(ts|tsx|mts)$/.test(f) && !f.endsWith(".d.ts"));
const pkgJsons = allFiles.filter((f) => f.endsWith(`${sep}package.json`));

/** Юніт монорепо для файлу: { layer: 'packages'|'services'|'apps', name } або null (root). */
function unitOf(file) {
  const rel = relative(ROOT, file).split(sep);
  if (["packages", "services", "apps"].includes(rel[0]) && rel.length > 2) {
    return { layer: rel[0], name: rel[1] };
  }
  return null;
}

/** Мапа: ім'я workspace-пакета (@wiki/x) → юніт. */
const nameToUnit = new Map();
for (const pj of pkgJsons) {
  const unit = unitOf(pj);
  if (!unit) continue;
  try {
    const { name } = JSON.parse(readFileSync(pj, "utf8"));
    if (name) nameToUnit.set(name, unit);
  } catch {
    /* ігноруємо биті json */
  }
}

/* ── парсинг імпортів ────────────────────────────────────────────────── */

const IMPORT_RE =
  /(?:import|export)\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return { src, specs };
}

/* ── правила ─────────────────────────────────────────────────────────── */

const violations = [];
const flag = (file, rule, msg) =>
  violations.push(`${relative(ROOT, file).replaceAll(sep, "/")}  [${rule}] ${msg}`);

const EXTERNAL_OWNERS = [
  { module: "nats", owner: "events", rule: "A1", hint: "шину обходити не можна — лише через @wiki/events" },
  { module: "postgres", owner: "db", rule: "A2", hint: "Postgres-драйвер — лише в @wiki/db (createDb)" },
  { module: "minio", owner: "storage", rule: "A3", hint: "MinIO — лише через @wiki/storage (ObjectStore)" },
  { module: "playwright", owner: "engine-adapters", rule: "A4", hint: "браузер — лише в адаптерах рушіїв" },
];

// apps/api споживає chat-orchestrator як бібліотеку — єдиний дозволений виняток L3/L5
const SERVICE_LIB_EXCEPTIONS = new Set(["@wiki/chat-orchestrator"]);

for (const file of tsFiles) {
  const unit = unitOf(file);
  if (!unit) continue;
  const { src, specs } = importsOf(file);

  for (const spec of specs) {
    const isRelative = spec.startsWith(".");
    const isInternal = spec.startsWith("@wiki/");
    const base = isInternal ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

    // A5: deep-імпорти внутрішніх пакетів
    if (isInternal && /\/(src|dist)\//.test(spec)) {
      flag(file, "A5", `deep-імпорт "${spec}" — використовуй exports пакета`);
    }

    // Зовнішні модулі з єдиним власником
    if (!isRelative && !isInternal) {
      for (const { module: mod, owner, rule, hint } of EXTERNAL_OWNERS) {
        if ((base === mod || spec === mod) && !(unit.layer === "packages" && unit.name === owner)) {
          flag(file, rule, `"${spec}" дозволено лише в packages/${owner} — ${hint}`);
        }
      }
    }

    // Межі шарів для внутрішніх імпортів
    if (isInternal) {
      const target = nameToUnit.get(base);
      if (!target) continue;

      if (unit.layer === "packages") {
        if (unit.name === "contracts") {
          flag(file, "L1", `contracts не має імпортувати "${base}"`);
        } else if (!(target.layer === "packages" && target.name === "contracts")) {
          flag(file, "L2", `packages/${unit.name} може імпортувати лише @wiki/contracts, не "${base}"`);
        }
      }

      if (unit.layer === "services" && target.layer === "services") {
        flag(file, "L3", `сервіс імпортує сервіс "${base}" — спілкування лише через події NATS`);
      }

      if (unit.layer === "apps" && unit.name === "web") {
        if (!(target.layer === "packages" && target.name === "contracts")) {
          flag(file, "L4", `apps/web може імпортувати лише @wiki/contracts, не "${base}"`);
        }
      }

      if (unit.layer === "apps" && unit.name === "api" && target.layer === "services") {
        if (!SERVICE_LIB_EXCEPTIONS.has(base)) {
          flag(file, "L5", `apps/api не імпортує сервіси (виняток — @wiki/chat-orchestrator), не "${base}"`);
        }
      }
    }

    // C1: ESM-відносні імпорти з .js (apps/web — bundler resolution, пропускаємо)
    if (isRelative && !(unit.layer === "apps" && unit.name === "web")) {
      if (!/\.(js|json)$/.test(spec)) {
        flag(file, "C1", `відносний імпорт "${spec}" без суфікса .js (ESM)`);
      }
    }
  }

  // C3: SIGTERM у main.ts воркерів
  if (unit.layer === "services" && file.endsWith(`src${sep}main.ts`) && !src.includes("SIGTERM")) {
    flag(file, "C3", "воркер не обробляє SIGTERM (graceful shutdown з bus.drain())");
  }
}

// C2: внутрішні залежності — workspace:*
for (const pj of pkgJsons) {
  const unit = unitOf(pj);
  if (!unit) continue;
  const json = JSON.parse(readFileSync(pj, "utf8"));
  for (const depsKey of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, ver] of Object.entries(json[depsKey] ?? {})) {
      if (dep.startsWith("@wiki/") && ver !== "workspace:*") {
        flag(pj, "C2", `${depsKey}.${dep} = "${ver}" — має бути "workspace:*"`);
      }
    }
  }
}

/* ── звіт ────────────────────────────────────────────────────────────── */

if (violations.length) {
  console.error(`✗ Порушення архітектури (${violations.length}):\n`);
  for (const v of violations) console.error("  " + v);
  console.error("\nПравила описані в CLAUDE.md та scripts/check-arch.mjs.");
  process.exit(2);
} else {
  if (!QUIET) console.log(`✓ Архітектура консистентна (${tsFiles.length} файлів перевірено)`);
}
