import { readState, writeState } from "./state.js";
import { searchProducts } from "./api.js";
import type { Product } from "./parse.js";

/**
 * The user's reorder catalog and pick preferences. Nothing is auto-added until
 * the user explicitly saves staples with auto: true.
 */
export interface Staple {
  /** Canonical key, e.g. "milk", "bread". */
  key: string;
  /** Search query used to find candidates. */
  query: string;
  /** Preferred brand(s), highest priority first. */
  brands?: string[];
  /** Required attribute keywords (matched against name/variant), e.g. ["full cream"]. */
  attrs?: string[];
  /** Preferred unit/pack hint, e.g. "500 ml". */
  unit?: string;
  /** Default quantity to add. */
  quantity?: number;
  /** Eligible for silent full-auto add. */
  auto?: boolean;
  /** Pin an exact product id (skips scoring). */
  product_id?: number;
}

export interface Prefs {
  staples: Staple[];
  scorer: ScorerWeights;
  /** Auto-swap to a cheaper equivalent only if it saves at least this fraction. */
  swap_savings_threshold: number;
}

export interface ScorerWeights {
  brand: number;
  attr: number;
  eta: number;
  price: number;
}

const DEFAULT_PREFS: Prefs = {
  // "balance brand & price": brand/attr matter most, then availability, then price.
  scorer: { brand: 5, attr: 4, eta: 3, price: 2 },
  swap_savings_threshold: 0.15,
  staples: [],
};

export async function loadPrefs(): Promise<Prefs> {
  const saved = await readState<Prefs>("staples.json");
  if (saved) return { ...DEFAULT_PREFS, ...saved };
  await savePrefs(DEFAULT_PREFS);
  return DEFAULT_PREFS;
}

export async function savePrefs(p: Prefs): Promise<void> {
  await writeState("staples.json", p);
}

const has = (hay: string | undefined, needle: string) =>
  (hay ?? "").toLowerCase().includes(needle.toLowerCase());

/**
 * Multi-factor scorer. Returns the best product plus the ranked alternatives and
 * an explanation, honoring brand/attr filters and the cheaper-equivalent swap rule.
 */
export function pickBest(
  candidates: Product[],
  opts: { brands?: string[]; attrs?: string[]; maxPrice?: number; unit?: string },
  weights: ScorerWeights,
  swapThreshold: number,
): { chosen?: Product; alternatives: Product[]; reason: string } {
  // Hard filters first.
  let pool = candidates.filter((p) => (p.inventory ?? 1) > 0);
  if (opts.attrs?.length) {
    const strict = pool.filter((p) =>
      opts.attrs!.every((a) => has(p.name, a) || has(p.unit, a) || has(p.brand, a)),
    );
    pool = strict;
  }
  if (opts.maxPrice !== undefined) pool = pool.filter((p) => (p.price ?? Infinity) <= opts.maxPrice!);
  if (!pool.length) return { alternatives: [], reason: "No available product meets the filters" };

  const prices = pool.map((p) => p.price ?? Infinity).filter((n) => Number.isFinite(n));
  const minP = Math.min(...prices, Infinity);
  const maxP = Math.max(...prices, 0);
  const priceRange = maxP - minP || 1;

  const score = (p: Product): number => {
    const brand = opts.brands?.some((b) => has(p.brand, b) || has(p.name, b)) ? 1 : 0;
    const attr = opts.attrs?.length
      ? opts.attrs.filter((a) => has(p.name, a) || has(p.unit, a)).length / opts.attrs.length
      : 0;
    const eta = (p.inventory ?? 0) > 0 ? 1 : 0;
    const price = p.price !== undefined ? 1 - (p.price - minP) / priceRange : 0;
    return weights.brand * brand + weights.attr * attr + weights.eta * eta + weights.price * price;
  };

  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  let chosen = ranked[0];
  let reason = "top multi-factor score";

  // Cheaper-equivalent swap: if a same-attribute candidate is meaningfully
  // cheaper than the brand pick, switch to it.
  if (chosen && opts.brands?.length) {
    const brandPick = ranked.find((p) => opts.brands!.some((b) => has(p.brand, b) || has(p.name, b)));
    if (brandPick && brandPick.price !== undefined) {
      const cheaper = ranked.find(
        (p) =>
          p.price !== undefined &&
          p.price < brandPick.price! * (1 - swapThreshold) &&
          (!opts.attrs?.length || opts.attrs.every((a) => has(p.name, a) || has(p.unit, a))),
      );
      if (cheaper && cheaper !== brandPick) {
        chosen = cheaper;
        reason = `swapped to cheaper equivalent (saves ≥${Math.round(swapThreshold * 100)}% vs preferred brand)`;
      } else {
        chosen = brandPick;
        reason = "preferred brand kept (no meaningful cheaper equivalent)";
      }
    }
  }

  return { chosen, alternatives: ranked.filter((p) => p !== chosen).slice(0, 5), reason };
}

/** Resolve one staple to a live product using search + scorer. */
export async function resolveStaple(s: Staple, prefs: Prefs): Promise<Product | undefined> {
  const results = await searchProducts(s.query);
  if (s.product_id) {
    const exact = results.find((p) => p.product_id === s.product_id);
    if (exact) return exact;
  }
  const { chosen } = pickBest(
    results,
    { brands: s.brands, attrs: s.attrs, unit: s.unit },
    prefs.scorer,
    prefs.swap_savings_threshold,
  );
  return chosen;
}
