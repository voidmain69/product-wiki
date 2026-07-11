import Link from "next/link";
import { fetchProducts } from "@/lib/api";

/** Каталог товарів (SSR). Індексна сторінка «вікіпедії». */
export const dynamic = "force-dynamic";

export const metadata = { title: "Каталог — Вікіпедія товарів" };

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const items = await fetchProducts(q);

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}>
      <nav style={{ fontSize: 13, marginBottom: 16 }}>
        <Link href="/" style={{ color: "#58a6ff" }}>
          ← Чат
        </Link>
      </nav>
      <h1 style={{ marginTop: 0 }}>Каталог товарів</h1>
      <p style={{ color: "#8b93a1", fontSize: 14 }}>
        Достовірні дані з офіційних сайтів виробників. {items.length} товар(ів).
      </p>

      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
        {items.map((p) => (
          <li key={p.productId}>
            <Link
              href={`/products/${p.productId}`}
              style={{
                display: "block",
                padding: 14,
                border: "1px solid #22272e",
                borderRadius: 10,
                textDecoration: "none",
                color: "#e7eaee",
              }}
            >
              <strong>{p.brand}</strong> {p.name}
              {p.keySpecs.length > 0 && (
                <div style={{ color: "#8b93a1", fontSize: 13, marginTop: 4 }}>
                  {p.keySpecs.map((s) => `${s.label}: ${s.value}`).join(" · ")}
                </div>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p style={{ color: "#8b93a1" }}>Нічого не знайдено.</p>}
    </main>
  );
}
