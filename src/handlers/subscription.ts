import { Context } from "hono";
import { homedir, platform } from "node:os";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { info, error as logError } from "../utils/logger.js";

/**
 * Direct OAuth implementation for Claude.ai subscription sign-in.
 *
 * Instead of spawning the `claude` CLI in a PTY and trying to script its TUI
 * (which doesn't work on Windows because the CLI uses ESC[?9001h Win32 Input
 * Mode and reads console events directly, bypassing PTY stdin), this handler
 * performs the OAuth 2.0 PKCE flow itself:
 *
 *   1. Backend generates code_verifier + code_challenge + state.
 *   2. Backend builds the same authorize URL the CLI would build and hands
 *      it to the frontend to open in the user's browser.
 *   3. User signs in to claude.ai; Anthropic redirects to
 *      platform.claude.com/oauth/code/callback which displays the code as
 *      `{auth_code}#{state}`.
 *   4. User pastes that value back into our modal.
 *   5. Backend POSTs to /v1/oauth/token with grant_type=authorization_code,
 *      code_verifier, etc. — same call the CLI makes.
 *   6. Backend writes the returned tokens to ~/.claude/.credentials.json in
 *      the exact JSON shape the Claude CLI itself uses, so subsequent CLI
 *      runs (and our own status check) see the user as authenticated.
 *
 * Constants extracted from @anthropic-ai/claude-code 1.0.108 cli.js.
 */

const ANTHROPIC_OAUTH = {
  CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize",
  TOKEN_URL: "https://console.anthropic.com/v1/oauth/token",
  PROFILE_URL: "https://console.anthropic.com/api/oauth/profile",
  REDIRECT_URI: "https://platform.claude.com/oauth/code/callback",
  SCOPES: [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ],
};

type Phase =
  | "idle"
  | "browser_opened"
  | "verifying"
  | "success"
  | "no_subscription"
  | "error"
  | "cancelled";

interface SubscriptionEvent {
  t: number;
  msg: string;
}

interface SubscriptionState {
  phase: Phase;
  url: string | null;
  error: string | null;
  codeVerifier: string | null;
  state: string | null;
  startedAt: number | null;
  events: SubscriptionEvent[];
  /** Set after a successful sign-in. */
  subscriptionType: string | null;
}

let current: SubscriptionState = {
  phase: "idle",
  url: null,
  error: null,
  codeVerifier: null,
  state: null,
  startedAt: null,
  events: [],
  subscriptionType: null,
};

function reset(): void {
  current = {
    phase: "idle",
    url: null,
    error: null,
    codeVerifier: null,
    state: null,
    startedAt: null,
    events: [],
    subscriptionType: null,
  };
}

const MAX_EVENTS = 200;
function step(msg: string): void {
  info(msg);
  current.events.push({ t: Date.now(), msg });
  if (current.events.length > MAX_EVENTS) {
    current.events.splice(0, current.events.length - MAX_EVENTS);
  }
}

function setPhase(next: Phase, reason: string): void {
  if (current.phase === next) return;
  step(`[claude login] phase ${current.phase} → ${next} (${reason})`);
  current.phase = next;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64Url(randomBytes(32));
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(ANTHROPIC_OAUTH.AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", ANTHROPIC_OAUTH.CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", ANTHROPIC_OAUTH.REDIRECT_URI);
  url.searchParams.append("scope", ANTHROPIC_OAUTH.SCOPES.join(" "));
  url.searchParams.append("code_challenge", challenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", state);
  return url.toString();
}

function maskToken(s: string | null | undefined): string {
  if (!s) return "<none>";
  if (s.length <= 12) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export async function handleStartSubscription(c: Context) {
  step(`[claude login] === START requested === (current phase: ${current.phase})`);

  if (current.phase === "browser_opened" || current.phase === "verifying") {
    step(`[claude login] Reusing in-flight session — phase=${current.phase}.`);
    return c.json({
      phase: current.phase,
      url: current.url,
      urls: current.url ? [current.url] : [],
      error: current.error,
      events: current.events,
    });
  }

  reset();
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  current.codeVerifier = verifier;
  current.state = state;
  current.url = buildAuthorizeUrl(challenge, state);
  current.startedAt = Date.now();
  setPhase("browser_opened", "oauth params generated");
  step(`[claude login] OAuth URL generated (PKCE challenge_method=S256, state=${state.slice(0, 8)}…). User should open URL → sign in → paste {code}#{state}.`);

  return c.json({
    phase: current.phase,
    url: current.url,
    urls: [current.url],
    error: current.error,
    events: current.events,
  });
}

export async function handleSubscriptionStatus(c: Context) {
  const sinceParam = c.req.query("since");
  const since = sinceParam ? Number(sinceParam) : 0;
  const events = since > 0
    ? current.events.filter((e) => e.t > since)
    : current.events;
  return c.json({
    phase: current.phase,
    url: current.url,
    urls: current.url ? [current.url] : [],
    error: current.error,
    events,
    subscriptionType: current.subscriptionType,
  });
}

export async function handleSubmitSubscriptionCode(c: Context) {
  const body = await c.req.json<{ code?: string }>();
  const rawCode = (body.code ?? "").trim();
  step(`[claude login] === SUBMIT-CODE === phase=${current.phase} codeLen=${rawCode.length}`);

  if (!current.codeVerifier || !current.state) {
    return c.json(
      { ok: false, status: "error", error: "No active sign-in session. Click Start sign-in to begin." },
      400
    );
  }

  if (!rawCode) {
    return c.json(
      { ok: false, status: "error", error: "Paste the code from the Claude page first." },
      400
    );
  }

  // Reject obvious mistakes — user pasted the OAuth URL params verbatim.
  if (rawCode === current.state) {
    return c.json(
      { ok: false, status: "error", error: "That's the OAuth state, not the authorization code. Copy the code shown on the Claude sign-in page." },
      400
    );
  }

  // Parse {auth_code}#{state} format produced by platform.claude.com.
  let authCode = rawCode;
  let pastedState = "";
  const hashIdx = rawCode.indexOf("#");
  if (hashIdx > 0) {
    authCode = rawCode.slice(0, hashIdx);
    pastedState = rawCode.slice(hashIdx + 1);
  }

  if (pastedState && pastedState !== current.state) {
    step(`[claude login] State mismatch — session state=${current.state.slice(0, 8)}…, pasted state=${pastedState.slice(0, 8)}…`);
    return c.json(
      {
        ok: false,
        status: "error",
        error: "The pasted code is from a different sign-in attempt. Click Start sign-in again to get a fresh URL.",
      },
      400
    );
  }

  setPhase("verifying", "exchanging authorization code for tokens");

  // Step 1: exchange code for tokens.
  let tokens: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  try {
    step(`[claude login] POST ${ANTHROPIC_OAUTH.TOKEN_URL} (grant_type=authorization_code)`);
    const res = await fetch(ANTHROPIC_OAUTH.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: ANTHROPIC_OAUTH.REDIRECT_URI,
        client_id: ANTHROPIC_OAUTH.CLIENT_ID,
        code_verifier: current.codeVerifier,
        state: current.state,
      }),
    });
    step(`[claude login] Token endpoint responded: HTTP ${res.status} ${res.statusText}`);

    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* swallow */
      }
      const errMsg =
        res.status === 401
          ? "The authorization code is invalid or expired. Get a fresh code from the Claude sign-in page and try again."
          : `Token exchange failed (HTTP ${res.status}). ${detail.slice(0, 200)}`;
      setPhase("browser_opened", "token exchange rejected, awaiting retry");
      current.error = errMsg;
      step(`[claude login] Token exchange FAILED: ${errMsg}`);
      return c.json({ ok: false, status: "error", error: errMsg }, 400);
    }

    tokens = (await res.json()) as typeof tokens;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPhase("error", "token endpoint unreachable");
    current.error = `Couldn't reach the Anthropic token endpoint: ${msg}`;
    logError("[claude login] fetch token failed:", msg);
    return c.json({ ok: false, status: "error", error: current.error }, 502);
  }

  const { access_token, refresh_token, expires_in, scope } = tokens;
  if (!access_token) {
    setPhase("error", "no access_token in response");
    current.error = "Anthropic's response didn't include an access_token.";
    return c.json({ ok: false, status: "error", error: current.error }, 502);
  }
  step(`[claude login] Tokens received: access=${maskToken(access_token)}, refresh=${maskToken(refresh_token ?? null)}, expires_in=${expires_in ?? "<none>"}s.`);

  const expiresAt = Date.now() + (expires_in ?? 3600) * 1000;
  const scopes =
    typeof scope === "string" && scope.length > 0
      ? scope.split(/\s+/).filter(Boolean)
      : ANTHROPIC_OAUTH.SCOPES.slice();

  // Step 2: fetch profile to determine subscription tier. Best-effort and
  // NEVER blocks sign-in — if Anthropic returns an unrecognized shape (e.g.
  // newer fields, different field names for Claude.ai Max accounts) we just
  // save credentials with subscriptionType=null and trust the token. The
  // real validation happens at chat-time when the API rejects unpaid keys.
  let subscriptionType: string | null = null;
  try {
    step(`[claude login] GET ${ANTHROPIC_OAUTH.PROFILE_URL} to determine subscription tier…`);
    const profRes = await fetch(ANTHROPIC_OAUTH.PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
    });
    if (profRes.ok) {
      const profile = (await profRes.json()) as Record<string, unknown>;
      step(`[claude login] Profile response: ${JSON.stringify(profile).slice(0, 800)}`);
      subscriptionType = inferSubscriptionType(profile);
      step(`[claude login] Inferred subscriptionType=${subscriptionType ?? "<unknown — credentials saved anyway>"}`);
    } else {
      const body = await profRes.text().catch(() => "");
      step(`[claude login] Profile fetch returned HTTP ${profRes.status}. Body: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    step(`[claude login] Profile fetch failed (continuing): ${err instanceof Error ? err.message : err}`);
  }

  // Step 3: write credentials.json in the exact shape the Claude CLI uses,
  // so future CLI runs and our own status check both detect us as signed in.
  try {
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }
    const credPath = join(claudeDir, ".credentials.json");
    const payload = {
      claudeAiOauth: {
        accessToken: access_token,
        refreshToken: refresh_token ?? null,
        expiresAt,
        scopes,
        subscriptionType,
      },
    };
    writeFileSync(credPath, JSON.stringify(payload), { encoding: "utf-8" });
    if (platform() !== "win32") {
      try {
        chmodSync(credPath, 0o600);
      } catch {
        /* best-effort */
      }
    }
    step(`[claude login] Credentials saved to ${credPath}.`);
    current.subscriptionType = subscriptionType;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPhase("error", "credentials write failed");
    current.error = `Couldn't write credentials file: ${msg}`;
    logError("[claude login] write creds failed:", msg);
    return c.json({ ok: false, status: "error", error: current.error }, 500);
  }

  // Clear PKCE secrets — they've been used and shouldn't sit in memory.
  current.codeVerifier = null;
  current.state = null;

  // Always succeed if the token exchange worked. The CLI itself writes
  // credentials regardless of subscriptionType — the gate is at API-call
  // time. We do the same.
  setPhase("success", `sign-in completed (subscriptionType=${subscriptionType ?? "unknown"})`);
  return c.json({ ok: true, status: "submitted" });
}

/**
 * Walk the profile response looking for any signal that this account has a
 * paid Claude plan. We accept several known field locations and normalised
 * values because Anthropic's profile schema differs between the Console (API
 * developer) and Claude.ai (subscription) sides, and across CLI versions:
 *
 *   - { organization: { organization_type: "claude_max" } }    ← classic Console shape
 *   - { account: { type: "max" } }                              ← Claude.ai variant
 *   - { subscription: { plan: "pro" } }                         ← possible newer shape
 *   - { plan: "max" }                                            ← flat fallback
 */
function inferSubscriptionType(profile: Record<string, unknown>): string | null {
  const normalise = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null;
    const v = raw.toLowerCase().trim();
    if (!v || v === "free" || v === "none" || v === "null") return null;
    if (v.includes("max")) return "max";
    if (v.includes("pro")) return "pro";
    if (v.includes("enterprise")) return "enterprise";
    if (v.includes("team")) return "team";
    return v;
  };

  const get = (path: string[]): unknown =>
    path.reduce<unknown>((acc, k) => {
      if (acc && typeof acc === "object" && k in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[k];
      }
      return undefined;
    }, profile);

  const candidates: unknown[] = [
    get(["organization", "organization_type"]),
    get(["organization", "type"]),
    get(["organization", "plan"]),
    get(["organization", "subscription", "type"]),
    get(["organization", "subscription", "plan"]),
    get(["account", "type"]),
    get(["account", "plan"]),
    get(["account", "subscription", "type"]),
    get(["account", "subscription", "plan"]),
    get(["subscription", "type"]),
    get(["subscription", "plan"]),
    get(["plan"]),
    get(["tier"]),
    get(["account_type"]),
  ];

  for (const c of candidates) {
    const norm = normalise(c);
    if (norm) return norm;
  }
  return null;
}

export async function handleCancelSubscription(c: Context) {
  step(`[claude login] === CANCEL requested === (phase: ${current.phase})`);
  setPhase("cancelled", "user cancelled");
  reset();
  return c.json({ ok: true, phase: "cancelled" });
}
