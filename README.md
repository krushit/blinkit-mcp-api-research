# blinkit-mcp

An **API-only** [MCP](https://modelcontextprotocol.io) server for [Blinkit](https://blinkit.com)
(Indian quick-commerce). Every runtime call is a plain HTTPS request to `blinkit.com` — **no browser
automation in the happy path**. A browser is used only once, during research, to discover endpoints;
see [`RESEARCH.md`](./RESEARCH.md).

## How it works (the important bits)

- **Cloudflare TLS fingerprinting** blocks ordinary HTTP clients (curl, Node `fetch` → 403). We use
  [`impit`](https://www.npmjs.com/package/impit) to impersonate Chrome's TLS handshake, so requests
  pass with no browser and no cookie/challenge. This is what makes API-only possible.
- **Bootstrap:** `GET /v2/accounts/auth_key/` with a fixed `req_key` constant → device `auth_key`
  (no login). Sent on every call.
- **Login is headless OTP:** `send_otp(phone)` → `verify_otp(phone, code)` returns an
  `access_token` we persist. No browser ever involved.
- **Server-driven UI** responses are parsed defensively into clean product/order objects.

## Setup

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

Add to your MCP client (e.g. Claude Code `mcp` config):

```json
{
  "mcpServers": {
    "blinkit": {
      "command": "node",
      "args": ["/absolute/path/to/blinkit-mcp/dist/index.js"],
      "env": { "BLINKIT_MAX_ORDER_RUPEES": "2000" }
    }
  }
}
```

State is stored in `~/.blinkit-mcp/` (or the absolute `BLINKIT_STATE_DIR`). The directory is mode 700 and JSON files are mode 600:
- `session.json` — device id, auth_key, **access_token** (secret), location, store. chmod 600.
- `staples.json` — your reorder catalog + scorer weights.
- `cart.json` — the current working cart.
- `checkout.json` — the last validated checkout, valid for 10 minutes.
- `prepared-order.json` and `payment.json` — short-lived payment state. Treat these as secrets.

The MCP server uses stdio. It has no public HTTP listener. Any MCP client that can call its tools can read shopping results and, after login, act on the account. Connect it only to clients you trust.

## Tools

**Auth/login** — `blinkit_login_status`, `blinkit_send_otp`, `blinkit_verify_otp`, `blinkit_logout`
**Location** — `blinkit_set_location`, `blinkit_check_serviceability`
**Discovery** — `blinkit_search`, `blinkit_autosuggest`, `blinkit_pick_best`, `blinkit_recommendations`, `blinkit_home_feed`
**Cart** — `blinkit_add_to_cart`, `blinkit_remove_from_cart`, `blinkit_view_cart`, `blinkit_clear_cart`
**Reorder** — `blinkit_quick_reorder`, `blinkit_list_staples`, `blinkit_set_staple`
**Checkout/pay** — `blinkit_get_addresses`, `blinkit_checkout`, `blinkit_prepare_order`, `blinkit_pay_upi`, `blinkit_payment_status`
**Orders** — `blinkit_order_count`, `blinkit_order_history`

### Typical flow (set your own location and enable payment first)

```
blinkit_set_location { lat: 26.8467, lon: 80.9462 }            # example: Lucknow; use your delivery location
blinkit_send_otp     { phone: "9XXXXXXXXX" }
blinkit_verify_otp   { phone: "9XXXXXXXXX", code: "1234" }    # stores access_token + phone
blinkit_pick_best    { query: "milk", brands:["Amul"], attrs:["full cream"] }  # → product
blinkit_get_addresses                                        # → address_id
blinkit_checkout     { items: [ <chosen> ], address_id }     # → server cart_id (creates+binds+validates)
blinkit_pay_upi      { cart_id, confirm_payable: 250, method:"collect", vpa:"name@ybl", wait:true }
#   → pushes a UPI collect to PhonePe; streams status via notifications; you approve on your phone
```

### Payment status & notifications

- **`blinkit_pay_upi`** initiates UPI payment (`method:"qr"` returns a `upi://pay` intent link;
  `method:"collect"` + `vpa` pushes a collect request to your UPI app). With `wait:true` it polls
  `verifyPaymentStatus` until terminal and returns `final_status`.
- **`blinkit_payment_status`** checks the last (or a given) in-flight payment on demand — returns
  `pending` / `success` / `failed`.
- The server declares the MCP **`logging`** capability and emits `notifications/message` during the
  wait ("waiting for approval", "✅ approved", "❌ failed") — surfaced live by Claude Code.

> Payment is delegated to Zomato **zpaykit**; the human step is approving the UPI request in the UPI app.
> See `RESEARCH.md §8–9` for the full captured flow.

### Payment safety

Payment initiation is **off by default**. To enable it, set `BLINKIT_ENABLE_PAYMENT=true` in the MCP process environment after verifying your account and delivery address. `BLINKIT_MAX_ORDER_RUPEES` defaults to 2000; set a lower value if desired. Checkout must be validated in the last 10 minutes, and the amount passed as `confirm_payable` must exactly match both the validated cart and the prepared payment order. The server never returns PAS tokens or payment hashes to the MCP client. If a payment call times out, the attempt is recorded before the network call and cannot be repeated for that cart; check payment status and start a fresh checkout if needed.

`blinkit_prepare_order` reuses a recently prepared order instead of creating another payment session for the same cart. It is also disabled until payment is enabled.

The location must be set before search, catalog, or cart calls. Search without location can return HTTP 400. The search parser ranks matching products above unrelated promoted cards.

Verification on 2026-09-26: build and automated tests passed, the MCP stdio server listed tools and rejected payment by default, and a live **logged-out** Lucknow `blinkit_search("milk")` returned 13 relevant products. OTP login, authenticated checkout, and payment still need a test with the owner's account before they can be called verified.

## Notes / limits

- Unofficial, reverse-engineered API — no stability guarantees; header/version constants may need
  bumping. Respect Blinkit's ToS and rate limits; intended for personal automation.
- `auth_key` / `req_key` constants are overridable via `BLINKIT_REQ_KEY` if Blinkit rotates them.
- Not affiliated with or endorsed by Blinkit/Zomato. Use at your own risk.

## License

MIT — see [LICENSE](./LICENSE).
