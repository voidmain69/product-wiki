import { notFound } from "next/navigation";
import Link from "next/link";
import { fetchProduct, fetchRelated } from "@/lib/api";
import { C, SERIF, SANS } from "@/lib/theme";
import {
  SiteHeader,
  ThemeStyle,
  Thumb,
  SectionLabel,
  ProductCard,
  fmtDate,
  shortHost,
  fmtAttrValue,
} from "@/components/ui";

/**
 * SSR-сторінка товару — це і є «вікіпедія»: індексується пошуковиками, кожна
 * характеристика позначена першоджерелом (provenance). Дані лише від виробника.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await fetchProduct(id);
  return { title: p ? `${p.brand} ${p.name} — Вікіпедія товарів` : "Товар не знайдено" };
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await fetchProduct(id);
  if (!p) notFound();

  const related = await fetchRelated(p);
  const firstSource = p.sources[0]?.url;

  return (
    <>
      <ThemeStyle />
      <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: SANS }}>
        <SiteHeader />

        <article style={{ maxWidth: 980, margin: "0 auto", padding: "20px 24px 64px" }}>
          {/* хлібні крихти */}
          <nav style={{ fontSize: 12.5, color: C.mut, marginBottom: 18, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <Link href="/products" className="pw-wikilink">Каталог</Link>
            <span>/</span>
            <Link href={`/products?brand=${encodeURIComponent(p.brand)}`} className="pw-wikilink">{p.brand}</Link>
            {p.categoryPath.map((seg) => (
              <span key={seg} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <span>/</span>
                <Link href={`/products?category=${encodeURIComponent(seg)}`} className="pw-wikilink">{seg}</Link>
              </span>
            ))}
          </nav>

          {/* ── Герой ─────────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 32 }}>
            <Gallery images={p.images} />

            <div style={{ flex: 1, minWidth: 280 }}>
              <span style={{ fontSize: 12, color: C.terra, font: `600 12px ${SANS}`, letterSpacing: ".02em" }}>{p.brand}</span>
              <h1 style={{ font: `600 30px ${SERIF}`, margin: "2px 0 10px", lineHeight: 1.15, letterSpacing: "-.015em" }}>{p.name}</h1>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
                <span style={{ fontSize: 12, color: C.freshInk, background: C.freshBg, borderRadius: 999, padding: "4px 11px" }}>
                  оновлено {fmtDate(p.updatedAt)}
                </span>
                {p.mpn && <MetaPill k="MPN" v={p.mpn} />}
                {p.gtin && <MetaPill k="GTIN" v={p.gtin} />}
                <span style={{ fontSize: 12, color: C.mut2 }}>{p.attributes.length} характеристик</span>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Link href={`/?product=${p.productId}`} className="pw-terra-btn" style={{ font: `500 13.5px ${SANS}`, padding: "10px 18px", borderRadius: 10, border: "none", background: C.terra, color: "#fdfcfa", textDecoration: "none" }}>
                  Питати про це в чаті →
                </Link>
                {firstSource && (
                  <a href={firstSource} target="_blank" rel="noreferrer" className="pw-ghost-btn" style={{ font: `500 13.5px ${SANS}`, padding: "10px 16px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, color: C.mut2, textDecoration: "none" }}>
                    Сайт виробника ↗
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* ── Опис ──────────────────────────────────────────────── */}
          {p.texts.length > 0 && (
            <section style={{ marginBottom: 32, maxWidth: 720 }}>
              <SectionLabel>ОПИС</SectionLabel>
              {p.texts.map((t, i) => (
                <p key={i} style={{ margin: i === 0 ? 0 : "10px 0 0", lineHeight: 1.7, fontSize: 15, color: C.mut2 }}>
                  {t.text}{" "}
                  <a className="pw-wikilink" href={t.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>↗ джерело</a>
                </p>
              ))}
            </section>
          )}

          {/* ── Характеристики з provenance ───────────────────────── */}
          {p.attributes.length > 0 && (
            <section style={{ marginBottom: 32 }}>
              <SectionLabel>ХАРАКТЕРИСТИКИ · КОЖНА ЦИФРА З ПЕРШОДЖЕРЕЛОМ</SectionLabel>
              <div style={{ border: `1px solid ${C.borderPanel}`, borderRadius: 14, overflow: "hidden", background: C.panel }}>
                {p.attributes.map((a, i) => (
                  <div
                    key={a.key + i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(160px, 1fr) 1.4fr auto",
                      gap: 12,
                      alignItems: "baseline",
                      padding: "11px 16px",
                      fontSize: 14,
                      borderTop: i === 0 ? "none" : `1px solid ${C.borderPanel}`,
                    }}
                  >
                    <div style={{ color: C.mut3 }}>{a.label}</div>
                    <div style={{ fontWeight: 500 }}>{fmtAttrValue(a.value, a.unit)}</div>
                    <a
                      className="pw-wikilink"
                      href={a.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={`Джерело виробника, знімок ${fmtDate(a.snapshotDate)}`}
                      style={{ fontSize: 11.5, whiteSpace: "nowrap" }}
                    >
                      ✓ {shortHost(a.sourceUrl)}
                    </a>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Першоджерела ──────────────────────────────────────── */}
          {p.sources.length > 0 && (
            <section style={{ marginBottom: 32 }}>
              <SectionLabel>ПЕРШОДЖЕРЕЛА</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                {p.sources.map((s, i) => (
                  <div key={i}>
                    <a className="pw-wikilink" href={s.url} target="_blank" rel="noreferrer">{shortHost(s.url)}</a>
                    <span style={{ color: C.mut }}> · знімок {fmtDate(s.fetchedAt)}</span>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12.5, color: C.mut, marginTop: 12, lineHeight: 1.6 }}>
                Дані зібрано з офіційного сайту виробника. Сервіс некомерційний; ми не продаємо товари.
              </p>
            </section>
          )}

          {/* ── Схожі товари ──────────────────────────────────────── */}
          {related.length > 0 && (
            <section>
              <SectionLabel>СХОЖІ ТОВАРИ</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
                {related.map((r) => (
                  <ProductCard key={r.productId} item={r} />
                ))}
              </div>
            </section>
          )}
        </article>
      </div>
    </>
  );
}

/** Галерея: головне фото + смужка мініатюр (SSR, без клієнтського стану). */
function Gallery({ images }: { images: string[] }) {
  const main = images[0] ?? null;
  return (
    <div style={{ width: 320, flex: "none", maxWidth: "100%" }}>
      <div style={{ border: `1px solid ${C.borderPanel}`, borderRadius: 16, overflow: "hidden", background: C.panel, aspectRatio: "1 / 1", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {main ? (
          <img src={main} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : (
          <Thumb src={null} size={180} radius={0} />
        )}
      </div>
      {images.length > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {images.slice(1, 6).map((src, i) => (
            <Thumb key={i} src={src} size={52} radius={9} />
          ))}
        </div>
      )}
    </div>
  );
}

function MetaPill({ k, v }: { k: string; v: string }) {
  return (
    <span style={{ fontSize: 12, color: C.mut2, background: C.chip, borderRadius: 6, padding: "4px 9px" }}>
      <span style={{ color: C.mut }}>{k}:</span> {v}
    </span>
  );
}
