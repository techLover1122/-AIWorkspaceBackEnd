/**
 * Workspace-level presence tracking.
 *
 * The user is "present" iff at least one live SSE stream is open to the
 * backend (i.e. the chat panel has an active connection somewhere). When
 * the last stream closes — typically because the user closed the
 * workspace tab — we flip to absent. A fresh subscribe flips back.
 *
 * One workspace = one user, so no need to key by userId — a global
 * counter is the right granularity.
 *
 * Used by whatsappBridge.shouldNotifyWhatsApp: absent users get
 * notifications forwarded to WhatsApp immediately, present users go
 * through the 5-min idle path instead.
 *
 * Hooked from handleChatStreamRequest in chatStream.ts: increment on
 * stream open, decrement in BOTH the cancel callback (immediate, fires
 * on tab close) and the cleanup path (covers terminal events + error
 * paths). Decrement is idempotent against double-fire.
 */

import { info } from "./logger.js";
import { EventEmitter } from "node:events";

let subscriberCount = 0;
const events = new EventEmitter();

export interface PresenceEvents {
  absent: () => void;
  present: () => void;
}

export function onPresenceChange<E extends keyof PresenceEvents>(
  event: E,
  listener: PresenceEvents[E]
): () => void {
  events.on(event, listener);
  return () => events.off(event, listener);
}

/** Returns true if at least one chat stream is currently open. */
export function isUserPresent(): boolean {
  return subscriberCount > 0;
}

/** Snapshot for debugging / status endpoints. */
export function getPresenceStatus() {
  return { present: subscriberCount > 0, subscribers: subscriberCount };
}

/** Bump on stream open. */
export function notifyStreamOpen(): void {
  subscriberCount += 1;
  if (subscriberCount === 1) {
    info("presence: user became present");
    events.emit("present");
  }
}

/**
 * Decrement on stream close. Returns a single-shot wrapper so the
 * caller can safely call it from multiple cleanup paths (cancel
 * callback AND the heartbeat-detected close) without going negative.
 */
export function notifyStreamClose(): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) {
      info("presence: user became absent (last stream closed)");
      events.emit("absent");
    }
  };
}
