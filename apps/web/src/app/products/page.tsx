import Link from "next/link";
import { fetchProducts, fetchFacets } from "@/lib/api";
import { C, SERIF, SANS } from "@/lib/theme";
import { SiteHeader, ThemeStyle, ProductCard, EmptyState, pluralProducts } from "@/components/ui";

/** Каталог товарів (SSR) — індексна сторінка «вікіпедії»: пошук, фасети, пагінація. */
export const dynamic = "force-dynamic";
export const metadata = { title: "Каталог — Вікіпедія товарів" };

const LIMIT = 24;
const SORTS: { key: string; label: string }[] = [
  { key: "updated", label: "Спершу свіжі" },
  { key: "name", label: "За назвою" },
  { key: "brand", label: "За брендом" },
];

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Побудова href із поточних параметрів + патч (undefined прибирає ключ, page→1 при зміні фільтра). */
function hrefWith(sp: SP, patch: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const k of ["q", "brand", "category", "sort", "page"]) {
    const v = one(sp[k]);
    if (v) params.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) params.delete(k);
    else params.set(k, v);
  }
  const s = params.toString();
  return s ? `/products?${s}` : "/products";
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const q = one(sp.q);
  const brand = one(sp.brand);
  const category = one(sp.category);
  const sort = one(sp.sort) ?? "updated";
  const page = Math.max(1, Number(one(sp.page) ?? 1) || 1);

  const [{ items, total }, facets] = await Promise.all([
    fetchProducts({ q, brand, category, sort: sort as never, page, limit: LIMIT }),
    fetchFacets(q),
  ]);

  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const activeChips = [
    brand ? { label: brand, href: hrefWith(sp, { brand: undefined, page: undefined }) } : null,
    category ? { label: category, href: hrefWith(sp, { category: undefined, page: undefined }) } : null,
  ].filter(Boolean) as { label: string; href: string }[];

  return (
    <>
      <ThemeStyle />
      <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: SANS }}>
        <SiteHeader q={q} />

        <div style={{ maxWidth: 1160, margin: "0 auto", padding: "24px 24px 64px", display: "flex", gap: 28, alignItems: "flex-start" }}>
          {/* ── Фасети ─────────────────────────────────────────────── */}
          <aside style={{ width: 236, flex: "none", position: "sticky", top: 76, display: "flex", flexDirection: "column", gap: 22 }}>
            <FacetGroup title="БРЕНД">
              {facets.brands.map((b) => (
                <FacetLink
                  key={b.value}
                  active={brand === b.value}
                  href={hrefWith(sp, { brand: brand === b.value ? undefined : b.value, page: undefined })}
                  label={b.value}
                  count={b.count}
                />
              ))}
              {facets.brands.length === 0 && <FacetEmpty />}
            </FacetGroup>

            <FacetGroup title="КАТЕГОРІЯ">
              {facets.categories.map((c) => (
                <FacetLink
                  key={c.value}
                  active={category === c.value}
                  href={hrefWith(sp, { category: category === c.value ? undefined : c.value, page: undefined })}
                  label={c.value}
                  count={c.count}
                />
              ))}
              {facets.categories.length === 0 && <FacetEmpty />}
            </FacetGroup>
          </aside>

          {/* ── Результати ─────────────────────────────────────────── */}
          <main style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
              <div>
                <h1 style={{ font: `600 24px ${SERIF}`, margin: "0 0 4px", letterSpacing: "-.01em" }}>
                  {q ? <>Результати «{q}»</> : "Каталог товарів"}
                </h1>
                <p style={{ margin: 0, fontSize: 13.5, color: C.mut2 }}>
                  Достовірні дані лише з офіційних сайтів виробників · знайдено {pluralProducts(total)}
                </p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {SORTS.map((s) => (
                  <Link
                    key={s.key}
                    href={hrefWith(sp, { sort: s.key === "updated" ? undefined : s.key, page: undefined })}
                    className={sort === s.key ? "pw-facet-on" : "pw-facet"}
                    style={{ font: `500 12.5px ${SANS}`, padding: "6px 11px", borderRadius: 8, border: `1px solid ${C.border}`, textDecoration: "none", color: sort === s.key ? C.bg : C.mut2, background: sort === s.key ? C.dark : C.panel }}
                  >
                    {s.label}
                  </Link>
                ))}
              </div>
            </div>

            {activeChips.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                {activeChips.map((c) => (
                  <Link key={c.label} href={c.href} className="pw-ghost-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6, font: `500 12.5px ${SANS}`, padding: "5px 11px", borderRadius: 999, border: `1px solid ${C.border}`, background: C.panel, color: C.mut2, textDecoration: "none" }}>
                    {c.label} <span style={{ color: C.mut, fontSize: 14, lineHeight: 1 }}>×</span>
                  </Link>
                ))}
                <Link href={hrefWith({}, {})} style={{ font: `500 12.5px ${SANS}`, padding: "5px 4px", color: C.terra, textDecoration: "none" }} className="pw-wikilink">
                  скинути все
                </Link>
              </div>
            )}

            {items.length === 0 ? (
              <EmptyState title="Нічого не знайдено" hint="Спробуйте інший запит або зніміть фільтри." />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                {items.map((it) => (
                  <ProductCard key={it.productId} item={it} />
                ))}
              </div>
            )}

            {pages > 1 && (
              <nav style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 28 }}>
                <PageLink disabled={page <= 1} href={hrefWith(sp, { page: String(page - 1) })} label="←" />
                {pageWindow(page, pages).map((n, i) =>
                  n === 0 ? (
                    <span key={`gap${i}`} style={{ color: C.mut, padding: "0 4px" }}>…</span>
                  ) : (
                    <PageLink key={n} current={n === page} href={hrefWith(sp, { page: n === 1 ? undefined : String(n) })} label={String(n)} />
                  ),
                )}
                <PageLink disabled={page >= pages} href={hrefWith(sp, { page: String(page + 1) })} label="→" />
              </nav>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

function FacetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ font: `600 11px ${SANS}`, letterSpacing: ".09em", color: C.mut, marginBottom: 10 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{children}</div>
    </div>
  );
}

function FacetLink({ active, href, label, count }: { active: boolean; href: string; label: string; count: number }) {
  return (
    <Link
      href={href}
      className={active ? "pw-facet-on" : "pw-facet"}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", borderRadius: 8, textDecoration: "none", font: `${active ? 600 : 400} 13px ${SANS}`, color: active ? C.bg : C.mut2, background: active ? C.dark : "transparent" }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 11.5, color: active ? "rgba(246,242,236,.7)" : C.mut, flex: "none" }}>{count}</span>
    </Link>
  );
}

function FacetEmpty() {
  return <div style={{ fontSize: 12.5, color: C.mut, padding: "4px 10px" }}>—</div>;
}

function PageLink({ href, label, current, disabled }: { href: string; label: string; current?: boolean; disabled?: boolean }) {
  if (disabled) {
    return <span style={{ minWidth: 32, textAlign: "center", padding: "6px 8px", borderRadius: 8, color: C.mut, border: `1px solid ${C.borderPanel}`, fontSize: 13, opacity: 0.5 }}>{label}</span>;
  }
  return (
    <Link
      href={href}
      className={current ? "pw-facet-on" : "pw-facet"}
      style={{ minWidth: 32, textAlign: "center", padding: "6px 8px", borderRadius: 8, textDecoration: "none", fontSize: 13, color: current ? C.bg : C.mut2, background: current ? C.dark : C.panel, border: `1px solid ${current ? C.dark : C.border}` }}
    >
      {label}
    </Link>
  );
}

/** Вікно номерів сторінок з «…» (0 = розрив). */
function pageWindow(page: number, pages: number): number[] {
  const out = new Set<number>([1, pages, page, page - 1, page + 1]);
  const nums = [...out].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const res: number[] = [];
  let prev = 0;
  for (const n of nums) {
    if (prev && n - prev > 1) res.push(0);
    res.push(n);
    prev = n;
  }
  return res;
}
