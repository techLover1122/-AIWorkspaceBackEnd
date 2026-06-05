/**
 * SQLite-backed per-workspace user preferences.
 *
 * The workspace is provisioned per-user, so "workspace prefs" and "user
 * prefs" are 1:1 here. Persisted to the same data.sqlite the rest of
 * the backend uses; lost on EC2 rebuild from snapshot (user has to
 * re-toggle once after a rebuild).
 *
 * Today: whatsappForwardingEnabled — when true, WhatsApp notifies fire
 * for every eligible event regardless of presence or idle timers (see
 * whatsappBridge.shouldNotifyWhatsApp).
 */

import { db } from "./db.js";
import { info } from "./logger.js";

const KEY_WHATSAPP_FORWARDING = "whatsapp_forwarding_enabled";

const stmtGet = db.prepare(`SELECT value FROM user_prefs WHERE key = ?`);
const stmtUpsert = db.prepare(`
  INSERT INTO user_prefs (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

function getBool(key: string, fallback: boolean): boolean {
  const row = stmtGet.get(key) as { value: string } | undefined;
  if (!row) return fallback;
  return row.value === "1";
}

function setBool(key: string, value: boolean): void {
  stmtUpsert.run(key, value ? "1" : "0", Date.now());
}

export function getWhatsAppForwardingEnabled(): boolean {
  return getBool(KEY_WHATSAPP_FORWARDING, false);
}

export function setWhatsAppForwardingEnabled(enabled: boolean): void {
  setBool(KEY_WHATSAPP_FORWARDING, enabled);
  info(`user_prefs: whatsapp_forwarding_enabled = ${enabled}`);
}
