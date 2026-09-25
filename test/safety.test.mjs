import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = await mkdtemp(join(tmpdir(), "blinkit-mcp-test-"));
process.env.BLINKIT_STATE_DIR = stateDir;

const { buildUrl } = await import("../dist/client.js");
const { writeState, readState, stateFile } = await import("../dist/state.js");
const { assertPayable, saveCheckout, requireCheckout, assertPaymentEnabled } = await import("../dist/safety.js");
const { prepareOrder } = await import("../dist/payment.js");
const { pickBest } = await import("../dist/staples.js");
const { rankSearchResults } = await import("../dist/search.js");

test("request URL stays on Blinkit", () => {
  assert.equal(buildUrl("/v1/layout/search", { q: "milk" }), "https://blinkit.com/v1/layout/search?q=milk");
  assert.throws(() => buildUrl("https://example.com/steal"), /relative/);
  assert.throws(() => buildUrl("//example.com/steal"), /relative/);
});

test("state files and directory stay private", async () => {
  await writeState("session.json", { access_token: "test-only" });
  assert.deepEqual(await readState("session.json"), { access_token: "test-only" });
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(stateFile("session.json"))).mode & 0o777, 0o600);
  await writeState("session.json", { access_token: "rotated" });
  assert.deepEqual(await readState("session.json"), { access_token: "rotated" });
  assert.equal((await stat(stateFile("session.json"))).mode & 0o777, 0o600);
});

test("product picker preserves availability, required attributes, and max price", () => {
  const candidates = [
    { product_id: 1, name: "Full cream milk", price: 100, inventory: 0 },
    { product_id: 2, name: "Toned milk", price: 40, inventory: 2 },
    { product_id: 3, name: "Full cream milk", price: 120, inventory: 2 },
  ];
  const weights = { brand: 5, attr: 4, eta: 3, price: 2 };
  assert.equal(pickBest(candidates, { attrs: ["full cream"], maxPrice: 50 }, weights, 0.15).chosen, undefined);
  assert.equal(pickBest(candidates, { maxPrice: 50 }, weights, 0.15).chosen?.product_id, 2);
});

test("search ranks relevant products above unrelated promoted cards", () => {
  const products = [
    { product_id: 1, name: "Chilli chips" },
    { product_id: 2, name: "Amul Gold Full Cream Milk" },
    { product_id: 3, name: "Soy milk" },
  ];
  assert.deepEqual(rankSearchResults("milk", products).map((p) => p.product_id), [2, 3]);
  assert.deepEqual(rankSearchResults("nonexistent", products), products);
  assert.equal(rankSearchResults("Goodnight Flash", [
    { product_id: 4, name: "Chilli chips" },
    { product_id: 5, name: "Good Knight Flash Refill" },
  ])[0].product_id, 5);
});

test("payment requires explicit enablement and a bounded recent checkout", async () => {
  delete process.env.BLINKIT_ENABLE_PAYMENT;
  assert.throws(assertPaymentEnabled, /disabled/);
  process.env.BLINKIT_ENABLE_PAYMENT = "true";
  assert.doesNotThrow(assertPaymentEnabled);
  delete process.env.BLINKIT_ENABLE_PAYMENT;
  assert.throws(() => assertPayable(undefined), /valid payable/);
  assert.throws(() => assertPayable(2001), /exceeds/);
  await saveCheckout({ cartId: "123", addressId: 4, payable: 250, createdAt: Date.now() });
  assert.equal((await requireCheckout("123")).payable, 250);
  await assert.rejects(requireCheckout("456"), /No recent validated checkout/);
  await assert.rejects(prepareOrder("456"), /No recent validated checkout/);
  await writeState("prepared-order.json", {
    cartId: "123", pasToken: "test-only", orderHash: "test-only", orderId: 77,
    payable: 250, paymentHash: "test-only", createdAt: Date.now(),
  });
  assert.equal((await prepareOrder("123")).orderId, 77);
  await saveCheckout({ cartId: "123", addressId: 4, payable: 251, createdAt: Date.now() });
  await assert.rejects(prepareOrder("123"), /differs/);
  await writeState("checkout.json", { cartId: "123", addressId: 4, payable: 250, createdAt: Date.now() - 11 * 60_000 });
  await assert.rejects(requireCheckout("123"), /No recent validated checkout/);
});
