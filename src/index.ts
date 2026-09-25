#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadSession } from "./session.js";
import { BlinkitError } from "./client.js";
import {
  sendOtp,
  verifyOtp,
  logout,
  setLocation,
  checkServiceability,
  searchProducts,
  autosuggest,
  getRecommendations,
  getHomeFeed,
  orderCount,
  orderHistory,
  getAddresses,
  prepareCheckout,
} from "./api.js";
import { addItems, removeItem, clearCart, viewCart } from "./cart.js";
import { prepareOrder, initUpiPayment, pollPaymentStatus, checkPaymentStatus, loadPaymentContext, userPhone } from "./payment.js";
import { loadPrefs, savePrefs, pickBest, resolveStaple, type Staple } from "./staples.js";
import { assertPaymentEnabled, requireCheckout } from "./safety.js";

const server = new McpServer(
  { name: "blinkit-mcp", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

/**
 * Emit an MCP logging notification (`notifications/message`) — surfaced by Claude Code. Used to
 * stream payment progress ("waiting for approval", "approved") while a tool blocks on polling.
 * Best-effort: ignored if the client isn't connected / doesn't accept logging.
 */
async function notify(level: "info" | "warning" | "error", message: string): Promise<void> {
  try {
    await server.server.sendLoggingMessage({ level, logger: "blinkit", data: message });
  } catch {
    /* client may not support logging; ignore */
  }
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Wrap a handler so any error becomes a clean MCP tool error result. */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
) {
  const cb = async (args: any): Promise<ToolResult> => {
    try {
      const result = await handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg =
        err instanceof BlinkitError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  };
  server.registerTool(name, { description, inputSchema: schema }, cb as any);
}

/* ----------------------------- Auth ----------------------------- */

tool("blinkit_login_status", "Show whether a user is logged in and the saved location/store.", {}, async () => {
  const s = await loadSession();
  return {
    logged_in: Boolean(s.access_token),
    user_id: s.user_id,
    location: s.lat !== undefined ? { lat: s.lat, lon: s.lon, label: s.location_label } : null,
    merchant_id: s.merchant_id,
  };
});

tool(
  "blinkit_send_otp",
  "Send a login OTP to a phone number (headless, no browser). Step 1 of login.",
  { phone: z.string().describe("10-digit Indian mobile number, e.g. 9876543210") },
  ({ phone }) => sendOtp(phone),
);

tool(
  "blinkit_verify_otp",
  "Verify the OTP and persist the access_token. Step 2 of login. NOTE: a wrong code returns ok:false even though Blinkit reports success.",
  { phone: z.string(), code: z.string().describe("OTP received via SMS") },
  ({ phone, code }) => verifyOtp(phone, code),
);

tool("blinkit_logout", "Clear the stored access_token.", {}, async () => {
  await logout();
  return { ok: true };
});

/* ----------------------------- Location ----------------------------- */

tool(
  "blinkit_set_location",
  "Resolve a lat/lon, confirm serviceability, pick the express dark store, and save it as the default delivery location.",
  { lat: z.number(), lon: z.number() },
  ({ lat, lon }) => setLocation(lat, lon),
);

tool(
  "blinkit_check_serviceability",
  "Check if Blinkit delivers to a lat/lon (does not change the saved location).",
  { lat: z.number(), lon: z.number() },
  async ({ lat, lon }) => {
    const res = await checkServiceability(lat, lon);
    return { serviceable: Boolean(res?.serviceable), city: res?.cityName };
  },
);

/* ----------------------------- Catalog ----------------------------- */

tool(
  "blinkit_search",
  "Search products. Returns clean product objects (id, name, brand, unit, price, mrp, inventory, eta) including the cart_item needed to add to cart.",
  { query: z.string(), page: z.number().int().min(0).optional() },
  ({ query, page }) => searchProducts(query, page ?? 0),
);

tool(
  "blinkit_autosuggest",
  "Typeahead suggestions for a partial query.",
  { query: z.string() },
  ({ query }) => autosuggest(query),
);

tool(
  "blinkit_pick_best",
  "Search and auto-pick the best product using the multi-factor scorer (brand + attributes + availability + price), with cheaper-equivalent swap. Returns the chosen product, alternatives, and the reason.",
  {
    query: z.string(),
    brands: z.array(z.string()).optional().describe("preferred brands, best first"),
    attrs: z.array(z.string()).optional().describe("required attribute keywords, e.g. ['full cream']"),
    max_price: z.number().positive().optional(),
  },
  async ({ query, brands, attrs, max_price }) => {
    const prefs = await loadPrefs();
    const results = await searchProducts(query);
    return pickBest(results, { brands, attrs, maxPrice: max_price }, prefs.scorer, prefs.swap_savings_threshold);
  },
);

tool(
  "blinkit_recommendations",
  "Products frequently bought with a given product id ('people also bought').",
  { product_id: z.number().int() },
  ({ product_id }) => getRecommendations(product_id),
);

tool("blinkit_home_feed", "Products surfaced on the home feed for the saved location.", {}, () => getHomeFeed());

/* ----------------------------- Cart ----------------------------- */

const itemShape = z
  .object({
    product_id: z.number().int(),
    merchant_id: z.number().int(),
    quantity: z.number().int().min(1).optional(),
    price: z.number().optional(),
    mrp: z.number().optional(),
    unit: z.string().optional(),
    inventory: z.number().optional(),
    group_id: z.number().optional(),
    merchant_type: z.string().optional(),
    eta_identifier: z.string().optional(),
    brand: z.string().optional(),
    display_name: z.string().optional(),
    product_name: z.string().optional(),
  })
  .passthrough();

tool(
  "blinkit_add_to_cart",
  "Add line items to the working cart and reprice. Pass the product objects (or their cart_item) returned by blinkit_search/blinkit_pick_best.",
  { items: z.array(itemShape).describe("cart_item objects from search/pick_best results") },
  ({ items }) => addItems(items),
);

tool(
  "blinkit_remove_from_cart",
  "Remove a product from the working cart by id and reprice.",
  { product_id: z.number().int() },
  ({ product_id }) => removeItem(product_id),
);

tool("blinkit_view_cart", "Show the working cart, repriced (items, payable amount, delivery, MROV).", {}, () => viewCart());

tool("blinkit_clear_cart", "Empty the working cart.", {}, async () => {
  await clearCart();
  return { ok: true };
});

/* ----------------------------- Reorder / staples ----------------------------- */

tool(
  "blinkit_quick_reorder",
  "Rebuild a basket from saved staples. With no keys, adds all auto-eligible staples silently; otherwise resolves the given staple keys. Returns the repriced cart and what was chosen for each item.",
  { keys: z.array(z.string()).optional().describe("staple keys to reorder; omit for all auto staples") },
  async ({ keys }) => {
    const prefs = await loadPrefs();
    const targets: Staple[] = keys?.length
      ? prefs.staples.filter((s) => keys.includes(s.key))
      : prefs.staples.filter((s) => s.auto);
    const picks: any[] = [];
    const toAdd: any[] = [];
    for (const st of targets) {
      const product = await resolveStaple(st, prefs);
      if (product?.cart_item) {
        const qty = st.quantity ?? 1;
        toAdd.push({ ...product.cart_item, quantity: qty });
        picks.push({ key: st.key, chosen: product.name, price: product.price, qty });
      } else {
        picks.push({ key: st.key, chosen: null, note: "no available product found" });
      }
    }
    const cart = toAdd.length ? await addItems(toAdd) : await viewCart();
    return { picks, cart };
  },
);

tool("blinkit_list_staples", "List the saved staple catalog and pick preferences.", {}, () => loadPrefs());

tool(
  "blinkit_set_staple",
  "Add or update a staple in the reorder catalog.",
  {
    key: z.string(),
    query: z.string(),
    brands: z.array(z.string()).optional(),
    attrs: z.array(z.string()).optional(),
    unit: z.string().optional(),
    quantity: z.number().int().min(1).optional(),
    auto: z.boolean().optional(),
    product_id: z.number().int().optional(),
  },
  async (args) => {
    const prefs = await loadPrefs();
    const next: Staple = { ...args };
    const idx = prefs.staples.findIndex((s) => s.key === args.key);
    if (idx >= 0) prefs.staples[idx] = next;
    else prefs.staples.push(next);
    await savePrefs(prefs);
    return { ok: true, staples: prefs.staples };
  },
);

/* ----------------------------- Addresses & headless checkout ----------------------------- */

tool("blinkit_get_addresses", "List saved delivery addresses (id, label, location). Requires login.", {}, () => getAddresses());

tool(
  "blinkit_checkout",
  "Headless checkout prep: create a real server cart from items, bind the delivery address, and validate. Returns the server cart_id to pass to blinkit_prepare_order / blinkit_pay_upi.",
  { items: z.array(itemShape), address_id: z.number().int() },
  ({ items, address_id }) => prepareCheckout(items as any, address_id),
);

/* ----------------------------- Payment (headless UPI via zpaykit) ----------------------------- */

tool(
  "blinkit_prepare_order",
  "Mint a payment session for a recently validated checkout. Returns order ID and payable amount, never payment credentials.",
  { cart_id: z.string().describe("the server cart id (from the web cart / checkout)") },
  async ({ cart_id }) => {
    assertPaymentEnabled();
    const order = await prepareOrder(cart_id);
    return { cart_id: order.cartId, order_id: order.orderId, payable: order.payable };
  },
);

tool(
  "blinkit_pay_upi",
  "Initiate UPI payment on a prepared order via Zomato zpaykit. method 'qr' returns a upi://pay intent link to open on the phone; method 'collect' attempts to push a collect request to the given VPA (PhonePe). Then poll status.",
  {
    cart_id: z.string(),
    method: z.enum(["qr", "collect"]).default("qr"),
    vpa: z.string().optional().describe("payer UPI id for collect, e.g. name@ybl"),
    confirm_payable: z.number().positive().describe("exact payable rupees shown by checkout or prepare_order"),
    wait: z.boolean().default(false).describe("if true, poll verifyPaymentStatus until terminal"),
  },
  async ({ cart_id, method, vpa, confirm_payable, wait }) => {
    assertPaymentEnabled();
    const checkout = await requireCheckout(cart_id);
    if (checkout.payable !== confirm_payable) throw new Error("Confirmed amount differs from validated checkout");
    if (method === "collect" && (!vpa || !/^[^\s@]+@[^\s@]+$/.test(vpa))) {
      throw new Error("A valid VPA is required for UPI collect");
    }
    if ((await loadPaymentContext())?.cartId === cart_id) {
      throw new Error("Payment was already initiated for this cart. Check its status before starting a new checkout.");
    }
    const phone = await userPhone();
    if (!phone) throw new Error("No phone on file; set BLINKIT_PHONE or log in again.");
    const order = await prepareOrder(cart_id);
    if (order.payable !== confirm_payable) throw new Error("Confirmed amount differs from payment order");
    const { result, client } = await initUpiPayment(order, phone, { method, vpa });
    await notify(
      "info",
      method === "collect"
        ? `UPI collect for ₹${order.payable} sent — approve it in your UPI app.`
        : `UPI request ready for ₹${order.payable} — open the intent link / scan to approve in PhonePe.`,
    );
    if (wait && result.trackId) {
      let last = "";
      const status = await pollPaymentStatus(client, order, phone, {
        onUpdate: async (s) => {
          if (s !== last) {
            last = s;
            await notify(/fail|declin|cancel|timeout/i.test(s) ? "warning" : "info", `Payment ${s} (₹${order.payable}, order ${order.orderId}).`);
          }
        },
      });
      const ok = /success|paid|complete/i.test(status);
      await notify(ok ? "info" : "warning", ok ? `✅ Payment approved — order ${order.orderId} placed.` : `❌ Payment ${status} for order ${order.orderId}.`);
      return { order: { orderId: order.orderId, payable: order.payable }, payment: result, final_status: status };
    }
    return { order: { orderId: order.orderId, payable: order.payable }, payment: result, note: "Use blinkit_payment_status to check, or pass wait:true to stream updates." };
  },
);

tool(
  "blinkit_payment_status",
  "Check the status of the last (or a specific) in-flight UPI payment without re-initiating it. Returns pending / success / failed.",
  { cart_id: z.string().optional().describe("optional; defaults to the most recent payment") },
  async ({ cart_id }) => {
    const r = await checkPaymentStatus(cart_id);
    await notify("info", `Payment status for order ${r.order_id ?? "?"}: ${r.status}.`);
    return r;
  },
);

/* ----------------------------- Orders ----------------------------- */

tool("blinkit_order_count", "Lifetime order counts (delivered/live/cancelled). Requires login.", {}, () => orderCount());

tool(
  "blinkit_order_history",
  "Recent orders with totals, status, item names, and reorder product ids. Requires login.",
  {},
  () => orderHistory(),
);

/* ----------------------------- Boot ----------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so we never corrupt the stdio JSON-RPC stream
  console.error("blinkit-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
