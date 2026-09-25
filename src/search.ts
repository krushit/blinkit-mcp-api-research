import type { Product } from "./parse.js";

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Search responses can include unrelated promoted cards; keep matching cards first. */
export function rankSearchResults(query: string, products: Product[]): Product[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const phrase = compact(query);
  if (!terms.length) return products;
  const scored = products.map((product, index) => {
    const name = compact(`${product.name} ${product.brand ?? ""}`);
    const hits = terms.filter((term) => name.includes(term)).length;
    const score = (name.includes(phrase) ? 10 : 0) + hits;
    return { product, index, score };
  });
  if (!scored.some((entry) => entry.score > 0)) return products;
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.product);
}
