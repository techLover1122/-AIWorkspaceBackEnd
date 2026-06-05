/**
 * WhatsApp HTTP routes.
 *
 *  Frontend → backend:
 *    GET  /api/whatsapp/status        snapshot { paired, jid, phone, ... }
 *    GET  /api/whatsapp/qr            { qr, paired }  (polled by the modal)
 *    POST /api/whatsapp/pair-phone    { phone } → { pairingCode }
 *    POST /api/whatsapp/unlink        log out the linked device
 *
 *  Sidecar → backend:
 *    POST /api/whatsapp/incoming      webhook from the Go sidecar with
 *                                     the paired user's WhatsApp message
 *
 * The first four just proxy to the sidecar (see whatsappBridge.ts). The
 * webhook is the bidirectional brain — it routes incoming text into
 * either a pending permission/AskUserQuestion, or a brand-new chat turn.
 *
 * Webhook auth: both the sidecar and this backend share
 * WHATSAPP_AUTH_TOKEN via /etc/workspace.env. Without the right bearer
 * header the webhook returns 401, so a stray local process can't spoof
 * "incoming WhatsApp messages".
 */

import type { Context } from "hono";
import {
  handleIncomingMessage,
  invalidateWhatsAppLinkCache,
  isWhatsAppConfigured,
  sidecarPairPhone,
  sidecarQr,
  sidecarSetRecipient,
  sidecarStatus,
  sidecarUnlink,
} from "../utils/whatsappBridge.js";
import {
  getWhatsAppForwardingEnabled,
  setWhatsAppForwardingEnabled,
} from "../utils/userPrefs.js";
import { info, warn } from "../utils/logger.js";

const AUTH_TOKEN = process.env.WHATSAPP_AUTH_TOKEN ?? "";

function notConfigured(c: Context) {
  return c.json(
    {
      configured: false,
      error:
        "WhatsApp integration is not configured on this workspace. " +
        "Set WHATSAPP_AUTH_TOKEN in /etc/workspace.env and start ai-ide-whatsapp.service.",
    },
    503
  );
}

export async function handleWhatsAppStatus(c: Context) {
  if (!isWhatsAppConfigured()) return notConfigured(c);
  try {
    const status = await sidecarStatus();
    return c.json({ configured: true, ...(status as object) });
  } catch (err) {
    warn("WhatsApp status fetch failed:", {
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        configured: true,
        sidecarReachable: false,
        error: "Couldn't reach the WhatsApp sidecar on this workspace.",
      },
      502
    );
  }
}

export async function handleWhatsAppQr(c: Context) {
  if (!isWhatsAppConfigured()) return notConfigured(c);
  try {
    const data = await sidecarQr();
    return c.json(data);
  } catch (err) {
    warn("WhatsApp QR fetch failed:", {
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Sidecar unreachable" }, 502);
  }
}

export async function handleWhatsAppPairPhone(c: Context) {
  if (!isWhatsAppConfigured()) return notConfigured(c);
  let body: { phone?: string };
  try {
    body = (await c.req.json()) as { phone?: string };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.phone || typeof body.phone !== "string") {
    return c.json({ error: "phone is required" }, 400);
  }
  try {
    const data = await sidecarPairPhone(body.phone);
    return c.json(data);
  } catch (err) {
    warn("WhatsApp pair-phone failed:", {
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Sidecar unreachable" }, 502);
  }
}

export async function handleWhatsAppSetRecipient(c: Context) {
  if (!isWhatsAppConfigured()) return notConfigured(c);
  let body: { phone?: string };
  try {
    body = (await c.req.json()) as { phone?: string };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // Allow empty string to clear the override (fall back to self).
  const phone = typeof body.phone === "string" ? body.phone : "";
  try {
    const data = await sidecarSetRecipient(phone);
    return c.json(data);
  } catch (err) {
    warn("WhatsApp set-recipient failed:", {
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Sidecar unreachable" }, 502);
  }
}

export async function handleWhatsAppUnlink(c: Context) {
  if (!isWhatsAppConfigured()) return notConfigured(c);
  try {
    const data = await sidecarUnlink();
    invalidateWhatsAppLinkCache();
    return c.json(data);
  } catch (err) {
    warn("WhatsApp unlink failed:", {
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Sidecar unreachable" }, 502);
  }
}

/**
 * GET /api/whatsapp/forwarding
 *
 * Returns the per-workspace "always forward to WhatsApp" toggle. When
 * true, attention-events fire WhatsApp notifies on every event
 * regardless of presence or idle timers (trigger #1 of the three).
 * Stored in SQLite, lost on EC2 rebuild from snapshot.
 */
export function handleWhatsAppGetForwarding(c: Context) {
  return c.json({ enabled: getWhatsAppForwardingEnabled() });
}

/**
 * POST /api/whatsapp/forwarding  body: { enabled: boolean }
 */
export async function handleWhatsAppSetForwarding(c: Context) {
  let body: { enabled?: unknown };
  try {
    body = (await c.req.json()) as { enabled?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  setWhatsAppForwardingEnabled(body.enabled);
  return c.json({ enabled: body.enabled });
}

/**
 * POST /api/whatsapp/incoming
 *
 * Called by the Go sidecar whenever the paired user sends a WhatsApp
 * message. Body shape mirrors IncomingWebhook in webhook.go:
 *   { messageId, fromJid, chatJid, text, timestamp }
 */
export async function handleWhatsAppIncoming(c: Context) {
  if (!AUTH_TOKEN) {
    // The integration was never configured — somebody POSTed to the
    // webhook anyway. 401 keeps random callers from spoofing the
    // route in case WHATSAPP_AUTH_TOKEN ever lands empty by accident.
    return c.json({ error: "WhatsApp integration not configured" }, 401);
  }
  const auth = c.req.header("authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (got !== AUTH_TOKEN) {
    warn("WhatsApp webhook auth mismatch", {});
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: { text?: string; messageId?: string; fromJid?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.text !== "string") {
    return c.json({ error: "text is required" }, 400);
  }

  info("WhatsApp incoming:", {
    messageId: body.messageId,
    fromJid: body.fromJid,
    preview: body.text.slice(0, 120),
  });
  const result = await handleIncomingMessage(body.text);
  info("WhatsApp incoming routed:", { result });
  return c.json({ ok: true, result });
}
