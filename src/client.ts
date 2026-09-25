import { Impit } from "impit";
import { loadSession, updateSession, type Session } from "./session.js";

const BASE = "https://blinkit.com";

/**
 * Blinkit is behind Cloudflare bot-management that blocks clients whose TLS
 * (JA3/JA4) handshake doesn't look like a real browser — plain `fetch`/`undici`
 * and curl get a 403 HTML page. `impit` performs a Chrome-impersonating TLS
 * handshake, so requests pass without any browser, cookie, or challenge solve.
 * This is the keystone that keeps the runtime path browser-free.
 */
const impit = new Impit({ browser: "chrome" });

/**
 * The web app calls GET /v2/accounts/auth_key/ with a *fixed* `req_key`
 * (s.config.requestKey in the bundle). A random UUID returns 400 — this exact
 * constant is required. Override via BLINKIT_REQ_KEY if Blinkit ever rotates it.
 */
const REQ_KEY = process.env.BLINKIT_REQ_KEY ?? "c0e6868e-1180-400c-be51-f473479f1f0a";

// Constant client-identity headers observed on the consumer web app. Blinkit
// accepts these as plain values; they are not signed.
const STATIC_HEADERS: Record<string, string> = {
  app_client: "consumer_web",
  platform: "desktop_web",
  web_app_version: "1008010016",
  rn_bundle_version: "1009003012",
  app_version: "52434332",
  "x-age-consent-granted": "false",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
};

export class BlinkitError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "BlinkitError";
  }
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body (content-type: application/json). */
  json?: unknown;
  /** Form body (content-type: application/x-www-form-urlencoded). */
  form?: Record<string, string | number>;
  /** Extra one-off headers. */
  headers?: Record<string, string>;
  /** Whether to attach the user access_token header (default: if present). */
  authed?: boolean;
}

export function buildUrl(path: string, query?: RequestOpts["query"]): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Blinkit request path must be relative to blinkit.com");
  }
  const url = new URL(path, BASE);
  if (url.origin !== BASE) throw new Error("Unexpected Blinkit request origin");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * The single low-level request helper. Injects the standard Blinkit header set
 * (auth_key, device_id, session_uuid, lat/lon, client identity) so every tool
 * stays thin. No browser involved — plain HTTPS.
 */
export async function request<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
  const s = await loadSession();
  const headers: Record<string, string> = {
    ...STATIC_HEADERS,
    device_id: s.device_id,
    session_uuid: s.session_uuid,
    referer: BASE + "/",
    origin: BASE,
  };

  if (s.auth_key) headers.auth_key = s.auth_key;
  if (s.lat !== undefined) headers.lat = String(s.lat);
  if (s.lon !== undefined) headers.lon = String(s.lon);

  // Only send access_token when we actually have one. The web app sends the
  // literal string "null" when logged out, but some endpoints (e.g. /visibility)
  // reject that with 401 — omitting the header entirely is accepted everywhere.
  const wantAuth = opts.authed ?? true;
  if (wantAuth && s.access_token) headers.access_token = s.access_token;

  // Cookies. `/createOrder` (and likely other payment steps) validate the
  // `gr_1_accessToken` cookie — NOT just the access_token header — so we must
  // send it as a cookie too. gr_1_deviceId mirrors the device header.
  const cookies = [`gr_1_deviceId=${s.device_id}`];
  if (wantAuth && s.access_token) cookies.push(`gr_1_accessToken=${encodeURIComponent(s.access_token)}`);
  headers.cookie = cookies.join("; ");

  let body: string | undefined;
  if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(
      Object.fromEntries(Object.entries(opts.form).map(([k, v]) => [k, String(v)])),
    ).toString();
  } else if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if ((opts.method ?? "GET") === "POST") {
    headers["content-type"] = "application/json";
  }

  Object.assign(headers, opts.headers);

  const res = await impit.fetch(buildUrl(path, opts.query), {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }

  if (res.status >= 300) {
    throw new BlinkitError(`Blinkit ${res.status} on ${path}`, res.status, parsed);
  }
  return parsed as T;
}

/**
 * Ensure we have a device `auth_key`. Cheap and login-free; called lazily before
 * any catalog/cart/auth call.
 */
export async function ensureAuthKey(): Promise<string> {
  const s = await loadSession();
  if (s.auth_key) return s.auth_key;
  const res = await request<{ success: boolean; auth_key: string }>(
    "/v2/accounts/auth_key/",
    { headers: { req_key: REQ_KEY } },
  );
  if (!res?.auth_key) throw new BlinkitError("Failed to obtain auth_key", 0, res);
  await updateSession({ auth_key: res.auth_key });
  return res.auth_key;
}

export function requireLogin(s: Session): void {
  if (!s.access_token) {
    throw new BlinkitError("Not logged in. Call send_otp then verify_otp first.", 401);
  }
}

export function requireLocation(s: Session): void {
  if (s.lat === undefined || s.lon === undefined) {
    throw new BlinkitError("No location set. Call set_location(lat, lon) first.", 400);
  }
}
