/**
 * WhatsApp bridge — owns all backend ↔ sidecar plumbing.
 *
 * Outbound (agent → user):
 *   notifyTaskDone(taskId, text)         on `done` events with assistant text
 *   notifyPermission(taskId, payload)    when canUseTool fires
 *   notifyAskUserQuestion(taskId, ...)   when the SDK emits an AskUserQuestion tool_use
 *
 * Inbound (user → agent):
 *   handleIncomingMessage(text)          called by the /api/whatsapp/incoming webhook
 *     1. resolves a pending permission if the user replied yes/no/y/n
 *     2. resolves a pending AskUserQuestion if the user replied with numbers
 *     3. otherwise starts a fresh chat turn against the last active session
 *
 * Pairing / status / unlink endpoints just proxy to the Go sidecar; see
 * sidecarFetch().
 *
 * Configuration via env (set in /etc/workspace.env by cloud-init):
 *   WHATSAPP_SIDECAR_URL    http://127.0.0.1:8091   (default)
 *   WHATSAPP_AUTH_TOKEN     <shared secret>         (required for sidecar calls)
 *
 * When WHATSAPP_AUTH_TOKEN is unset, all outbound notifications no-op
 * silently so workspaces without WhatsApp wired up don't generate noise
 * in the logs every tool call.
 */

import { info, warn } from "./logger.js";
import { autoAllowPending, denyPending, isPending } from "../handlers/permission.js";
import type { PermissionRequestPayload } from "../handlers/permission.js";
import { isUserPresent, onPresenceChange } from "./presenceTracker.js";
import { getWhatsAppForwardingEnabled } from "./userPrefs.js";
import { publishEvent } from "../handlers/events.js";

const SIDECAR_URL = process.env.WHATSAPP_SIDECAR_URL ?? "http://127.0.0.1:8091";
const AUTH_TOKEN = process.env.WHATSAPP_AUTH_TOKEN ?? "";

/** Is the integration configured at all? Used to short-circuit the
 *  notify* hooks when the sidecar isn't deployed on this workspace. */
export function isWhatsAppConfigured(): boolean {
  return AUTH_TOKEN.length > 0;
}

/* ──────────────────────────────────────────────────────────────────
   Outbound state — what we last sent the user, so an incoming reply
   can be matched back to the pending interaction.
   ────────────────────────────────────────────────────────────────── */

type PendingPermissionRef = {
  permissionId: string;       // matches handlers/permission.ts pending map
  toolName: string;
  taskId: string;
  sentAt: number;
};

type PendingAskRef = {
  taskId: string;
  toolUseId: string;
  questions: Array<{
    header?: string;
    question?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
  /** Captured so the follow-up chat call resumes the same conversation. */
  sessionId: string | null;
  workingDirectory: string | null;
  permissionMode: string | null;
  sentAt: number;
};

let pendingPermission: PendingPermissionRef | null = null;
let pendingAsk: PendingAskRef | null = null;

/* ──────────────────────────────────────────────────────────────────
   Last-active-session — the chat handler updates this whenever it
   detects a sessionId, so an incoming WhatsApp message can resume the
   conversation the user was last working on.
   ────────────────────────────────────────────────────────────────── */

type LastSession = {
  sessionId: string | null;
  workingDirectory: string | null;
  permissionMode: string | null;
};

let lastSession: LastSession = {
  sessionId: null,
  workingDirectory: null,
  permissionMode: null,
};

export function rememberSession(snapshot: LastSession): void {
  lastSession = { ...snapshot };
}

export function getLastSession(): LastSession {
  return { ...lastSession };
}

/* ──────────────────────────────────────────────────────────────────
   Notification gating (the three-trigger rule)

   A WhatsApp notify fires when at least ONE of these is true:
     1. User opted in (per-workspace SQLite flag — survives reconnect,
        lost on EC2 rebuild from snapshot).
     2. User is absent — the workspace tab is closed, so no live SSE
        stream is open (see presenceTracker).
     3. The user-attention event has been pending for 5 minutes with no
        resolution (deferred-notify scheduler below).

   When none of these are true the notify is SUPPRESSED — case 3
   schedules a 5-min delayed fire; cases 1 and 2 fire immediately.

   Eligibility also requires:
     - WhatsApp configured (WHATSAPP_AUTH_TOKEN set, isWhatsAppConfigured)
     - WhatsApp paired (sidecar /status reports paired: true)
   When either is false, "never" — silently drop.

   New event types added later MUST go through shouldNotifyWhatsApp or
   they'll bypass the gate.
   ────────────────────────────────────────────────────────────────── */

const FIVE_MIN_MS = 5 * 60 * 1000;
const LINK_CACHE_TTL_MS = 30_000;

let linkCache: { paired: boolean; checkedAt: number } | null = null;
let linkInflight: Promise<boolean> | null = null;

/** Cached "is WhatsApp paired" check. Hits the sidecar at most once per
 *  30s in the steady state. Safe to call from hot paths. */
export async function isWhatsAppLinked(): Promise<boolean> {
  if (!isWhatsAppConfigured()) return false;
  const now = Date.now();
  if (linkCache && now - linkCache.checkedAt < LINK_CACHE_TTL_MS) {
    return linkCache.paired;
  }
  if (linkInflight) return linkInflight;
  linkInflight = (async () => {
    try {
      const res = await sidecarFetch("/status");
      if (!res.ok) {
        warn("isWhatsAppLinked: sidecar /status non-ok", { status: res.status });
        linkCache = { paired: false, checkedAt: Date.now() };
        return false;
      }
      const body = (await res.json()) as { paired?: boolean };
      const paired = body.paired === true;
      linkCache = { paired, checkedAt: Date.now() };
      return paired;
    } catch (err) {
      warn("isWhatsAppLinked: sidecar /status threw", {
        err: err instanceof Error ? err.message : String(err),
      });
      linkCache = { paired: false, checkedAt: Date.now() };
      return false;
    } finally {
      linkInflight = null;
    }
  })();
  return linkInflight;
}

/** Invalidate the cache — call from the toggle endpoint or after
 *  pair/unlink so the next gating decision uses fresh state. */
export function invalidateWhatsAppLinkCache(): void {
  linkCache = null;
}

export type NotifyDecision = "now" | "defer-5min" | "never";

/** Decide whether (and when) to fire a WhatsApp notify for an
 *  attention-event. Synchronous on the cached side; the link check is
 *  async because we don't want stale state to silently disable the
 *  integration. */
export async function shouldNotifyWhatsApp(): Promise<NotifyDecision> {
  if (!isWhatsAppConfigured()) return "never";
  if (!(await isWhatsAppLinked())) return "never";
  if (getWhatsAppForwardingEnabled()) return "now"; // case 1: opt-in
  if (!isUserPresent()) return "now";              // case 2: absent
  return "defer-5min";                              // case 3: idle timer
}

/* ──────────────────────────────────────────────────────────────────
   Deferred-notify scheduler

   For case 3 ("user idle 5 min on a pending prompt") we schedule the
   notify and arm two cancellation paths:
     - the prompt resolved (user answered in-app) → cancel
     - the user became absent → fire immediately and cancel the timer
       (case 2 short-circuits case 3)

   Keyed by (taskId, key) so callers can cancel a specific pending
   notify without affecting unrelated ones. `key` is the event type
   plus any disambiguator (permissionId, toolUseId, etc.).
   ────────────────────────────────────────────────────────────────── */

type DeferredNotify = {
  taskId: string;
  key: string;
  sessionId: string | null;
  timer: ReturnType<typeof setTimeout>;
  fire: () => Promise<void>;
};

const deferredNotifies = new Map<string, DeferredNotify>();

function deferredId(taskId: string, key: string): string {
  return `${taskId}:${key}`;
}

export interface DeferredNotifyOptions {
  /** Tag with a sessionId so cancelDeferredNotifyForSession can sweep
   *  all entries for that session — used by the task-completion case
   *  where a new turn on the same session means "user is back, drop
   *  the pending phone ping". */
  sessionId?: string | null;
  delayMs?: number;
}

export function scheduleDeferredNotify(
  taskId: string,
  key: string,
  fire: () => Promise<void>,
  opts: DeferredNotifyOptions = {}
): void {
  cancelDeferredNotify(taskId, key);
  const id = deferredId(taskId, key);
  const delay = opts.delayMs ?? FIVE_MIN_MS;
  const timer = setTimeout(() => {
    deferredNotifies.delete(id);
    void fire().catch((err) => {
      warn("deferred notify fire threw", {
        taskId,
        key,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, delay);
  deferredNotifies.set(id, {
    taskId,
    key,
    sessionId: opts.sessionId ?? null,
    timer,
    fire,
  });
}

export function cancelDeferredNotify(taskId: string, key: string): void {
  const id = deferredId(taskId, key);
  const entry = deferredNotifies.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  deferredNotifies.delete(id);
}

/** Cancel every deferred notify tagged with the given sessionId.
 *  Called when a new chat turn lands for that session — "user replied,
 *  no need to ping phone". */
export function cancelDeferredNotifyForSession(sessionId: string): void {
  let cleared = 0;
  for (const [id, entry] of deferredNotifies) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    deferredNotifies.delete(id);
    cleared++;
  }
  if (cleared > 0) {
    info("cancelDeferredNotifyForSession cleared entries", { sessionId, cleared });
  }
}

// When the user closes the workspace tab while one or more deferred
// notifies are armed, fire them all immediately — case 2 supersedes
// case 3's "wait 5 min". One-time wire-up at module load.
onPresenceChange("absent", () => {
  if (deferredNotifies.size === 0) return;
  info("presence absent — firing all deferred WhatsApp notifies", {
    count: deferredNotifies.size,
  });
  const drained = Array.from(deferredNotifies.values());
  deferredNotifies.clear();
  for (const entry of drained) {
    clearTimeout(entry.timer);
    void entry.fire().catch((err) => {
      warn("absent-drain notify fire threw", {
        taskId: entry.taskId,
        key: entry.key,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
});

/* ──────────────────────────────────────────────────────────────────
   Sidecar HTTP client
   ────────────────────────────────────────────────────────────────── */

async function sidecarFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${SIDECAR_URL.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

/** Proxy GET /status. */
export async function sidecarStatus(): Promise<unknown> {
  const res = await sidecarFetch("/status");
  return res.json();
}

/** Proxy GET /qr. Triggers QR pairing on the sidecar if needed. */
export async function sidecarQr(): Promise<unknown> {
  const res = await sidecarFetch("/qr");
  return res.json();
}

/** Proxy POST /pair-phone. */
export async function sidecarPairPhone(phone: string): Promise<unknown> {
  const res = await sidecarFetch("/pair-phone", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
  return res.json();
}

/** Proxy POST /unlink. */
export async function sidecarUnlink(): Promise<unknown> {
  const res = await sidecarFetch("/unlink", { method: "POST" });
  // Clear any pending refs — they're meaningless after unlink.
  pendingPermission = null;
  pendingAsk = null;
  return res.json();
}

/** Proxy POST /recipient — set or clear the outbound phone. */
export async function sidecarSetRecipient(phone: string): Promise<unknown> {
  const res = await sidecarFetch("/recipient", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
  return res.json();
}

/** Internal: POST /send. Swallows errors with a warn log so the chat
 *  task never crashes because WhatsApp is unhappy. */
async function sidecarSend(text: string): Promise<boolean> {
  if (!isWhatsAppConfigured()) return false;
  try {
    const res = await sidecarFetch("/send", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      warn("WhatsApp send failed:", { status: res.status, body: body.slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    warn("WhatsApp send threw:", {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────
   Outbound notifications
   ────────────────────────────────────────────────────────────────── */

/** Truncate generously — WhatsApp text messages cap at ~65k chars but
 *  long agent replies on a phone screen are unreadable. */
function trim(text: string, max = 1500): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

export async function notifyTaskDone(
  taskId: string,
  finalAssistantText: string
): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  const text = finalAssistantText.trim();
  if (!text) return;
  await sidecarSend(`✅ Done.\n\n${trim(text)}`);
  info("WhatsApp notify: task done", { taskId, len: text.length });
}

export async function notifyPermission(
  taskId: string,
  payload: PermissionRequestPayload
): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  // Track so an incoming yes/no can be matched back to this id.
  pendingPermission = {
    permissionId: payload.id,
    toolName: payload.toolName,
    taskId,
    sentAt: Date.now(),
  };
  const summary =
    payload.toolGuardActionSummary ??
    payload.description ??
    payload.displayName ??
    payload.toolName;
  await sidecarSend(
    `🔐 Permission needed\n\n${trim(summary, 800)}\n\nReply *yes* to allow or *no* to deny.`
  );
  info("WhatsApp notify: permission", {
    taskId,
    permissionId: payload.id,
    tool: payload.toolName,
  });
}

export async function notifyAskUserQuestion(args: {
  taskId: string;
  toolUseId: string;
  questions: PendingAskRef["questions"];
  sessionId: string | null;
  workingDirectory: string | null;
  permissionMode: string | null;
}): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  pendingAsk = {
    taskId: args.taskId,
    toolUseId: args.toolUseId,
    questions: args.questions,
    sessionId: args.sessionId,
    workingDirectory: args.workingDirectory,
    permissionMode: args.permissionMode,
    sentAt: Date.now(),
  };
  // Format each question with numbered options. For multi-question
  // requests we just stack them; multi-select is mentioned in the hint.
  const blocks = args.questions.map((q, qi) => {
    const head =
      `Q${args.questions.length > 1 ? qi + 1 : ""}: ${q.question ?? q.header ?? "?"}`.trim();
    const opts = (q.options ?? [])
      .map((o, i) => `  ${i + 1}. ${o.label ?? "(no label)"}`)
      .join("\n");
    const hint = q.multiSelect ? "  (reply with comma-separated numbers)" : "";
    return [head, opts, hint].filter(Boolean).join("\n");
  });
  const body = blocks.join("\n\n");
  await sidecarSend(`❓ Question\n\n${trim(body, 1200)}\n\nReply with the option number(s).`);
  info("WhatsApp notify: askUserQuestion", {
    taskId: args.taskId,
    toolUseId: args.toolUseId,
    questionCount: args.questions.length,
  });
}

/* ──────────────────────────────────────────────────────────────────
   Inbound handler (called by /api/whatsapp/incoming)
   ────────────────────────────────────────────────────────────────── */

/** What we tell the webhook caller — also used by the handler test
 *  surface so we can log what we did with each message. */
export type IncomingResult =
  | { kind: "permission_allow"; permissionId: string }
  | { kind: "permission_deny"; permissionId: string }
  | { kind: "ask_answer"; toolUseId: string; followUpPreview: string }
  | { kind: "new_chat"; taskId: string }
  | { kind: "ignored"; reason: string };

export async function handleIncomingMessage(text: string): Promise<IncomingResult> {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "ignored", reason: "empty text" };

  // 1. Pending permission? Parse yes/no/y/n/1/2.
  if (pendingPermission) {
    const ref = pendingPermission;
    // If the permission already resolved server-side (timeout, abort),
    // forget it and fall through to the next branch instead of leaving
    // stale state.
    if (!isPending(ref.permissionId)) {
      pendingPermission = null;
    } else {
      const verdict = parseYesNo(trimmed);
      if (verdict === "allow") {
        autoAllowPending(ref.permissionId);
        pendingPermission = null;
        await sidecarSend(`👍 Allowed ${ref.toolName}.`);
        return { kind: "permission_allow", permissionId: ref.permissionId };
      }
      if (verdict === "deny") {
        denyPending(ref.permissionId, "Denied via WhatsApp");
        pendingPermission = null;
        await sidecarSend(`👎 Denied ${ref.toolName}.`);
        return { kind: "permission_deny", permissionId: ref.permissionId };
      }
      // Unrecognized reply with a permission pending — nudge the user.
      await sidecarSend(
        `Couldn't read that — reply *yes* / *no* (or *y* / *n*) to decide on ${ref.toolName}.`
      );
      return { kind: "ignored", reason: "unparseable permission reply" };
    }
  }

  // 2. Pending AskUserQuestion? Parse numbers → option labels → send
  //    a follow-up chat message in the same session.
  if (pendingAsk) {
    const ref = pendingAsk;
    const answers = parseAskAnswers(trimmed, ref.questions);
    if (answers) {
      pendingAsk = null;
      const followUp = buildAskFollowUp(ref.questions, answers);
      await startChatTurn({
        message: followUp,
        sessionId: ref.sessionId,
        workingDirectory: ref.workingDirectory,
        permissionMode: ref.permissionMode,
      });
      return {
        kind: "ask_answer",
        toolUseId: ref.toolUseId,
        followUpPreview: followUp.slice(0, 200),
      };
    }
    await sidecarSend(
      `Couldn't read that — reply with the option number(s). e.g. "1" or "1,3".`
    );
    return { kind: "ignored", reason: "unparseable ask reply" };
  }

  // 3. No pending interaction — treat as a fresh user prompt.
  const session = getLastSession();
  const res = await startChatTurn({
    message: trimmed,
    sessionId: session.sessionId,
    workingDirectory: session.workingDirectory,
    permissionMode: session.permissionMode,
  });
  return { kind: "new_chat", taskId: res.taskId };
}

function parseYesNo(text: string): "allow" | "deny" | null {
  const t = text.toLowerCase().trim().replace(/[.!?]+$/, "");
  if (["yes", "y", "yeah", "yep", "allow", "ok", "1"].includes(t)) return "allow";
  if (["no", "n", "nope", "deny", "stop", "2"].includes(t)) return "deny";
  return null;
}

/** Returns { [questionIndex]: number[] } where the inner array is the
 *  picked option indices (0-based). Single-select questions get a
 *  single-element array. Returns null if any question's reply can't be
 *  parsed. */
function parseAskAnswers(
  text: string,
  questions: PendingAskRef["questions"]
): Record<number, number[]> | null {
  // Multi-question requests are uncommon in practice; we treat the
  // whole reply as applying to question[0] and expect the agent to
  // re-ask if it actually had several. Keeps the WhatsApp UX simple.
  const q = questions[0];
  if (!q) return null;
  const max = q.options?.length ?? 0;
  if (max === 0) return null;
  const picks = text
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= max)
    .map((n) => n - 1);
  if (picks.length === 0) return null;
  if (!q.multiSelect && picks.length > 1) {
    // User picked multiple where single was asked — take the first.
    return { 0: [picks[0]] };
  }
  return { 0: picks };
}

function buildAskFollowUp(
  questions: PendingAskRef["questions"],
  answers: Record<number, number[]>
): string {
  const lines: string[] = [];
  for (const [qiStr, picks] of Object.entries(answers)) {
    const qi = parseInt(qiStr, 10);
    const q = questions[qi];
    if (!q) continue;
    const label = q.header ?? q.question ?? `Question ${qi + 1}`;
    const picked = picks
      .map((i) => q.options?.[i]?.label ?? `option ${i + 1}`)
      .join(", ");
    lines.push(`- ${label}\n  → ${picked}`);
  }
  return (
    `Here are my answers to your question${lines.length === 1 ? "" : "s"}:\n\n` +
    lines.join("\n") +
    `\n\nPlease continue.`
  );
}

/* ──────────────────────────────────────────────────────────────────
   Starting a chat turn from WhatsApp
   ──────────────────────────────────────────────────────────────────
   We call back into the same handleChatRequest path the frontend uses
   by hitting the local Hono server over HTTP. This keeps all of the
   middleware (Intent Guard, Tool Guard, system prompt assembly) in one
   place — the WhatsApp inbound flow is just another client. */

const LOCAL_BACKEND = process.env.SELF_BACKEND_URL ?? "http://127.0.0.1:8090";

async function startChatTurn(args: {
  message: string;
  sessionId: string | null;
  workingDirectory: string | null;
  permissionMode: string | null;
}): Promise<{ taskId: string }> {
  const requestId = `wa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body = {
    message: args.message,
    requestId,
    // Tag the turn as WhatsApp-originated so the chat handler bypasses
    // the presence/idle gate and routes replies + prompts straight back
    // to the phone. Also lets the handler default the working directory
    // to $HOME for cold-start friends with no prior session seed.
    origin: "whatsapp" as const,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.workingDirectory ? { workingDirectory: args.workingDirectory } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
  };
  try {
    const res = await fetch(`${LOCAL_BACKEND}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn("WhatsApp → /api/chat failed:", {
        status: res.status,
        body: text.slice(0, 200),
      });
      await sidecarSend(
        `Couldn't start the chat turn (HTTP ${res.status}). Check the workspace.`
      );
      return { taskId: requestId };
    }
    const json = (await res.json().catch(() => ({}))) as { taskId?: string };
    const actualTaskId = json.taskId ?? requestId;
    publishEvent({ type: "task_started", taskId: actualTaskId, origin: "whatsapp" });
    info("WhatsApp → /api/chat started:", { requestId: actualTaskId });
  } catch (err) {
    warn("WhatsApp → /api/chat threw:", {
      err: err instanceof Error ? err.message : String(err),
    });
    await sidecarSend(
      `Couldn't reach the workspace backend — try again or open the app.`
    );
  }
  return { taskId: requestId };
}

/* ──────────────────────────────────────────────────────────────────
   Test seam — let unit tests reset state without restarting the
   process. Not exposed via the public API.
   ────────────────────────────────────────────────────────────────── */
export const __testInternals = {
  reset(): void {
    pendingPermission = null;
    pendingAsk = null;
    lastSession = {
      sessionId: null,
      workingDirectory: null,
      permissionMode: null,
    };
  },
  getPendingPermission: () => pendingPermission,
  getPendingAsk: () => pendingAsk,
};
