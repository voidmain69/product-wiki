import { notFound } from "next/navigation";
import Link from "next/link";
import { fetchProduct } from "@/lib/api";

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

  const fmtDate = (iso: string) => iso.slice(0, 10);

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}>
      <nav style={{ fontSize: 13, color: "#8b93a1", marginBottom: 12 }}>
        <Link href="/products" style={{ color: "#58a6ff" }}>
          ← Каталог
        </Link>
        {p.categoryPath.length > 0 && <span> · {p.categoryPath.join(" / ")}</span>}
      </nav>

      <h1 style={{ margin: "0 0 4px" }}>
        {p.brand} {p.name}
      </h1>
      <div style={{ color: "#8b93a1", fontSize: 13, marginBottom: 24 }}>
        {p.mpn && <span>MPN: {p.mpn} · </span>}
        {p.gtin && <span>GTIN: {p.gtin} · </span>}
        оновлено {fmtDate(p.updatedAt)}
      </div>

      {p.texts.map((t, i) => (
        <p key={i} style={{ lineHeight: 1.6 }}>
          {t.text}{" "}
          <a href={t.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#58a6ff" }}>
            [джерело]
          </a>
        </p>
      ))}

      <h2 style={{ fontSize: 18, marginTop: 24 }}>Характеристики</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}>
        <tbody>
          {p.attributes.map((a) => (
            <tr key={a.key} style={{ borderBottom: "1px solid #22272e" }}>
              <td style={{ padding: "8px 0", color: "#8b93a1", width: "40%" }}>{a.label}</td>
              <td style={{ padding: "8px 0" }}>
                {a.value}
                {a.unit ? ` ${a.unit}` : ""}
              </td>
              <td style={{ padding: "8px 0", textAlign: "right" }}>
                <a
                  href={a.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`Джерело виробника, станом на ${fmtDate(a.snapshotDate)}`}
                  style={{ fontSize: 12, color: "#58a6ff" }}
                >
                  ✓ джерело
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section style={{ marginTop: 24, fontSize: 12, color: "#8b93a1" }}>
        <strong>Першоджерела:</strong>
        <ul>
          {p.sources.map((s, i) => (
            <li key={i}>
              <a href={s.url} target="_blank" rel="noreferrer" style={{ color: "#58a6ff" }}>
                {s.url}
              </a>{" "}
              (станом на {fmtDate(s.fetchedAt)})
            </li>
          ))}
        </ul>
        <p>
          Дані зібрано з офіційного сайту виробника. <Link href="/" style={{ color: "#58a6ff" }}>Запитати чат про цей товар →</Link>
        </p>
      </section>
    </main>
  );
}
