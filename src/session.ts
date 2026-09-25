import { randomUUID, randomBytes } from "node:crypto";
import { readState, writeState } from "./state.js";

/**
 * Persistent session/device state for the Blinkit MCP.
 *
 * Stored at ~/.blinkit-mcp/session.json. Contains the device identity, the
 * device-level `auth_key` (no login needed), the user `access_token` (after OTP
 * login), and the user's default location/store. This file holds secrets
 * (access_token) — it lives outside the repo and is chmod 600 on write.
 */
export interface Session {
  /** Stable per-device id, generated once. Sent as the `device_id` header. */
  device_id: string;
  /** Per-install session uuid. Sent as the `session_uuid` header. */
  session_uuid: string;
  /** Device key from GET /v2/accounts/auth_key/. Sent on every call. */
  auth_key?: string;
  /** User token from OTP verify (format `v2::<uuid>`). null/undefined = logged out. */
  access_token?: string;
  /** Numeric Blinkit account id (from OTP verify response). */
  user_id?: number;
  /** Phone number (from OTP verify) — needed for the zpaykit payment calls. */
  phone?: string;
  /** Default delivery location. */
  lat?: number;
  lon?: number;
  /** Resolved address id (bound at checkout). */
  address_id?: number;
  /** Serving dark-store id for the location (from /visibility). */
  merchant_id?: number;
  /** Human label for the saved location, for display. */
  location_label?: string;
}

let cache: Session | null = null;

function freshSession(): Session {
  return {
    device_id: randomBytes(8).toString("hex"), // 16 hex chars, matches observed format
    session_uuid: randomUUID(),
  };
}

export async function loadSession(): Promise<Session> {
  if (cache) return cache;
  const saved = await readState<Session>("session.json");
  cache = saved ? { ...freshSession(), ...saved } : freshSession();
  if (!saved) await saveSession(cache);
  return cache;
}

export async function saveSession(s: Session): Promise<void> {
  await writeState("session.json", s);
  cache = s;
}

/** Merge a partial update into the session and persist. */
export async function updateSession(patch: Partial<Session>): Promise<Session> {
  const s = await loadSession();
  const next = { ...s, ...patch };
  await saveSession(next);
  return next;
}
