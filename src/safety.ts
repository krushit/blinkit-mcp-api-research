import { readState, writeState } from "./state.js";

export interface CheckoutContext {
  cartId: string;
  addressId: number;
  payable: number;
  createdAt: number;
}

export function maxOrderRupees(): number {
  const value = Number(process.env.BLINKIT_MAX_ORDER_RUPEES ?? "2000");
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid BLINKIT_MAX_ORDER_RUPEES");
  return value;
}

export function assertPayable(payable: unknown): asserts payable is number {
  if (typeof payable !== "number" || !Number.isFinite(payable) || payable <= 0) {
    throw new Error("Blinkit did not return a valid payable amount");
  }
  if (payable > maxOrderRupees()) {
    throw new Error(`Order total ₹${payable} exceeds the ₹${maxOrderRupees()} limit`);
  }
}

export function assertPaymentEnabled(): void {
  if (process.env.BLINKIT_ENABLE_PAYMENT !== "true") {
    throw new Error("Payment is disabled. Set BLINKIT_ENABLE_PAYMENT=true after reviewing the order and account configuration.");
  }
}

export async function saveCheckout(context: CheckoutContext): Promise<void> {
  assertPayable(context.payable);
  await writeState("checkout.json", context);
}

export async function requireCheckout(cartId: string): Promise<CheckoutContext> {
  const context = await readState<CheckoutContext>("checkout.json");
  if (!context || context.cartId !== cartId || Date.now() - context.createdAt > 10 * 60_000) {
    throw new Error("No recent validated checkout for this cart. Run blinkit_checkout again.");
  }
  assertPayable(context.payable);
  return context;
}
