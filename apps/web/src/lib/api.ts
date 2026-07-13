import type {
  ProductDetail,
  ProductListItem,
  ProductListResponse,
  ProductFacets,
} from "@wiki/contracts";

/**
 * Серверний доступ до API (SSR). apps/web не має БД — усі дані через HTTP.
 * Використовуємо внутрішній URL API на сервері Next.
 */
const API = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface ProductQuery {
  q?: string;
  brand?: string;
  category?: string;
  sort?: "updated" | "name" | "brand";
  page?: number;
  limit?: number;
}

export async function fetchProduct(id: string): Promise<ProductDetail | null> {
  const res = await fetch(`${API}/products/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as ProductDetail;
}

export async function fetchProducts(query: ProductQuery = {}): Promise<ProductListResponse> {
  const url = new URL(`${API}/products`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "" && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { items: [], total: 0 };
  return (await res.json()) as ProductListResponse;
}

export async function fetchFacets(
  filters: { q?: string; brand?: string; category?: string } = {},
): Promise<ProductFacets> {
  const url = new URL(`${API}/products/facets`);
  for (const [k, v] of Object.entries(filters)) {
    if (v) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { brands: [], categories: [] };
  return (await res.json()) as ProductFacets;
}

/**
 * Схожі товари для сторінки товару: спершу за останнім рівнем категорії, інакше — за
 * брендом. Виключаємо сам товар; беремо кілька карток.
 */
export async function fetchRelated(product: ProductDetail, limit = 6): Promise<ProductListItem[]> {
  const category = product.categoryPath.at(-1);
  const primary = category
    ? await fetchProducts({ category, limit: limit + 1 })
    : { items: [], total: 0 };
  const items = primary.items.filter((i) => i.productId !== product.productId);
  if (items.length < 3) {
    const byBrand = await fetchProducts({ brand: product.brand, limit: limit + 1 });
    const seen = new Set(items.map((i) => i.productId));
    for (const i of byBrand.items) {
      if (i.productId !== product.productId && !seen.has(i.productId)) items.push(i);
    }
  }
  return items.slice(0, limit);
}
