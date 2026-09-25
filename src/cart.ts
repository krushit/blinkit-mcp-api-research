import { readState, writeState } from "./state.js";
import { computeCart, type CartView } from "./api.js";
import type { CartItem } from "./parse.js";

/**
 * A stateful working cart persisted to disk. Blinkit's /v5/carts is stateless
 * (you post the full item list each time), so we keep the line items locally and
 * reprice on every change.
 */
async function load(): Promise<CartItem[]> {
  return (await readState<CartItem[]>("cart.json")) ?? [];
}

async function save(items: CartItem[]): Promise<void> {
  await writeState("cart.json", items);
}

function normalize(raw: any, quantity?: number): CartItem {
  // Accept either a full cart_item or a {product_id, merchant_id, ...} shape.
  const item: CartItem = {
    product_id: Number(raw.product_id),
    merchant_id: Number(raw.merchant_id),
    quantity: quantity ?? raw.quantity ?? 1,
    product_name: raw.product_name ?? raw.display_name ?? raw.name,
    display_name: raw.display_name ?? raw.name,
    price: raw.price,
    mrp: raw.mrp,
    unit: raw.unit,
    inventory: raw.inventory,
    group_id: raw.group_id,
    merchant_type: raw.merchant_type,
    eta_identifier: raw.eta_identifier,
    brand: raw.brand,
  };
  return item;
}

export async function addItems(rawItems: any[]): Promise<CartView & { lines: CartItem[] }> {
  const cart = await load();
  for (const raw of rawItems) {
    const item = normalize(raw, raw.quantity);
    if (!Number.isSafeInteger(item.product_id) || item.product_id <= 0 ||
        !Number.isSafeInteger(item.merchant_id) || item.merchant_id <= 0 ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error("Cart item requires valid product, merchant, and quantity");
    }
    const existing = cart.find((c) => c.product_id === item.product_id);
    if (existing) existing.quantity += item.quantity;
    else cart.push(item);
  }
  const view = await computeCart(cart);
  await save(cart);
  return { ...view, lines: cart };
}

export async function removeItem(productId: number): Promise<CartView & { lines: CartItem[] }> {
  let cart = await load();
  cart = cart.filter((c) => c.product_id !== productId);
  const view = await computeCart(cart);
  await save(cart);
  return { ...view, lines: cart };
}

export async function clearCart(): Promise<void> {
  await save([]);
}

export async function viewCart(): Promise<CartView & { lines: CartItem[] }> {
  const cart = await load();
  const view = await computeCart(cart);
  return { ...view, lines: cart };
}
