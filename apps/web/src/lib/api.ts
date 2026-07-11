import type { ProductDetail, ProductListItem } from "@wiki/contracts";

/**
 * Серверний доступ до API (SSR). apps/web не має БД — усі дані через HTTP.
 * Використовуємо внутрішній URL API на сервері Next.
 */
const API = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export async function fetchProduct(id: string): Promise<ProductDetail | null> {
  const res = await fetch(`${API}/products/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as ProductDetail;
}

export async function fetchProducts(q?: string): Promise<ProductListItem[]> {
  const url = new URL(`${API}/products`);
  if (q) url.searchParams.set("q", q);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  return ((await res.json()) as { items: ProductListItem[] }).items;
}
