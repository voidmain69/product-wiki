import Link from "next/link";
import type { ProductListItem } from "@wiki/contracts";
import { C, SERIF, SANS, HOVER_CSS } from "@/lib/theme";

/**
 * Спільні server-компоненти «вікіпедії» (каталог + сторінка товару) у стилі Hi-Fi.
 * Без клієнтських хуків — сторінки лишаються SSR (індексовані, share-able URL).
 */

/** Один раз рендеримо hover/стан-CSS дизайну (inline-стилі не вміють :hover). */
export function ThemeStyle() {
  return <style dangerouslySetInnerHTML={{ __html: HOVER_CSS }} />;
}

/** Верхня навігація: логотип, розділи, пошук (GET-форма → /products?q=). */
export function SiteHeader({ q }: { q?: string }) {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        gap: 20,
        padding: "12px 24px",
        background: "rgba(253,252,250,.85)",
        backdropFilter: "blur(8px)",
        borderBottom: `1px solid ${C.borderPanel}`,
      }}
    >
      <Link href="/products" style={{ textDecoration: "none", color: C.ink, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, background: C.terra, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fdfcfa", font: `600 14px ${SERIF}` }}>
          В
        </span>
        <span style={{ font: `600 16px ${SERIF}`, letterSpacing: "-.01em" }}>Вікіпедія товарів</span>
      </Link>

      <nav style={{ display: "flex", gap: 4, marginLeft: 4 }}>
        <Link href="/products" className="pw-ghost-btn" style={navLink}>Каталог</Link>
        <Link href="/" className="pw-ghost-btn" style={navLink}>Чат-дослідник</Link>
      </nav>

      <form action="/products" method="get" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", border: `1px solid ${C.border}`, borderRadius: 10, background: C.panel, minWidth: 220 }}>
        <span style={{ color: C.mut, fontSize: 14 }}>⌕</span>
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Пошук товарів…"
          aria-label="Пошук товарів"
          style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", font: `400 13.5px ${SANS}`, color: C.ink }}
        />
      </form>
    </header>
  );
}

const navLink = {
  font: `500 13.5px ${SANS}`,
  color: C.mut2,
  textDecoration: "none",
  padding: "7px 12px",
  borderRadius: 9,
  border: `1px solid transparent`,
} as const;

/** Плейсхолдер/фото товару (діагональна штриховка як у дизайні). */
export function Thumb({ src, size, radius = 12 }: { src: string | null; size: number; radius?: number }) {
  if (src) {
    return <img src={src} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: radius, objectFit: "cover", flex: "none", background: C.chip }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: radius, flex: "none", background: "repeating-linear-gradient(45deg,#f3ede4,#f3ede4 7px,#ebe3d5 7px,#ebe3d5 14px)", display: "flex", alignItems: "center", justifyContent: "center", font: "11px ui-monospace,monospace", color: C.mut }}>
      фото
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ font: `600 11px ${SANS}`, letterSpacing: ".09em", color: C.mut, marginBottom: 10 }}>{children}</div>;
}

/** Картка товару в каталозі — уся картка є посиланням на вікі-сторінку. */
export function ProductCard({ item }: { item: ProductListItem }) {
  return (
    <Link
      href={`/products/${item.productId}`}
      className="pw-card"
      style={{
        display: "flex",
        gap: 14,
        padding: 14,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        textDecoration: "none",
        color: C.ink,
        transition: "border-color .15s, box-shadow .15s",
      }}
    >
      <Thumb src={item.thumbnail} size={76} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
        <div>
          <div style={{ font: `600 14.5px ${SERIF}`, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
            <span style={{ color: C.terra }}>{item.brand}</span> {item.name}
          </div>
          {item.categoryPath.length > 0 && (
            <div style={{ fontSize: 11.5, color: C.mut, marginTop: 2 }}>{item.categoryPath.join(" / ")}</div>
          )}
        </div>
        {item.keySpecs.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto" }}>
            {item.keySpecs.map((s) => (
              <span key={s.label} title={s.label} style={{ fontSize: 11.5, color: C.mut2, background: C.chip, borderRadius: 6, padding: "3px 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>
                {s.value}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

/** Порожній стан списку. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ padding: "60px 24px", textAlign: "center", color: C.mut2 }}>
      <div style={{ width: 56, height: 56, borderRadius: 12, margin: "0 auto 14px", background: "repeating-linear-gradient(45deg,#f3ede4,#f3ede4 7px,#ebe3d5 7px,#ebe3d5 14px)" }} />
      <div style={{ font: `600 16px ${SERIF}`, color: C.ink, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 13.5 }}>{hint}</div>}
    </div>
  );
}

/** Українська відмінка для «товар». */
export function pluralProducts(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} товар`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} товари`;
  return `${n} товарів`;
}

export function fmtDate(iso: string): string {
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}.${m}.${y}` : d;
}

export function shortHost(url: string): string {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** valueRaw зазвичай уже містить одиницю; дописуємо unit лише для «голого» числа. */
export function fmtAttrValue(value: string, unit: string | null): string {
  const bare = /^[\d.,\s-]+$/.test(value.trim());
  return bare && unit ? `${value} ${unit}` : value;
}
