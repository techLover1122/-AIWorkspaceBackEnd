import { Context } from "hono";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { info, debug as logDebug, warn } from "../utils/logger.js";

/**
 * Validate an Anthropic API key by listing models. Cheap, non-billable,
 * authoritative — Anthropic itself decides whether the key works.
 *
 * Returns a discriminated result so the frontend can render the right
 * error UI without parsing strings.
 */
async function validateAnthropicKey(
  key: string
): Promise<
  | { ok: true }
  | { ok: false; code: "invalid" | "forbidden" | "rate_limited" | "server" | "network"; status?: number; error: string }
> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch (err) {
    return {
      ok: false,
      code: "network",
      error:
        err instanceof Error
          ? `Could not reach Anthropic API: ${err.message}`
          : "Network error reaching Anthropic API",
    };
  }

  if (res.ok) return { ok: true };

  // Try to surface Anthropic's own error message when available.
  let detail = "";
  try {
    const json = (await res.json()) as { error?: { message?: string } };
    detail = json?.error?.message ?? "";
  } catch {
    /* not JSON */
  }

  if (res.status === 401) {
    return {
      ok: false,
      code: "invalid",
      status: 401,
      error:
        detail ||
        "Invalid API key — Anthropic rejected it. Check the key and try again.",
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      code: "forbidden",
      status: 403,
      error:
        detail ||
        "This API key doesn't have access to the required models (403). Check your workspace permissions.",
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      code: "rate_limited",
      status: 429,
      error:
        detail ||
        "Rate limited by Anthropic. Wait a moment and try again.",
    };
  }
  if (res.status >= 500) {
    return {
      ok: false,
      code: "server",
      status: res.status,
      error: `Anthropic server error (${res.status})${detail ? `: ${detail}` : ""}`,
    };
  }
  return {
    ok: false,
    code: "server",
    status: res.status,
    error: `Unexpected response from Anthropic (${res.status})${detail ? `: ${detail}` : ""}`,
  };
}

/**
 * Mask an API key for display — first 10 chars + last 4. Suitable for
 * showing "which key is in use" in the UI without exposing the secret.
 */
function maskKey(key: string): string {
  if (key.length <= 14) return "sk-ant-…";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

/**
 * Public helper used by /api/status.
 */
export function getMaskedApiKey(): string | null {
  const k = process.env.ANTHROPIC_API_KEY;
  return k ? maskKey(k) : null;
}

/**
 * POST /api/auth/api-key
 * Body: { apiKey: string }
 *
 * Validates the key against Anthropic's /v1/models endpoint BEFORE storing
 * it, so the user gets immediate feedback if the key is wrong / lacks
 * access / Anthropic is unreachable. Only persisted (in-memory) once the
 * validation passes.
 *
 * In-memory only — restarting the backend clears it (by design, to avoid
 * dropping secrets to disk).
 */
export async function handleSetApiKey(c: Context) {
  let body: { apiKey?: string };
  try {
    body = (await c.req.json()) as { apiKey?: string };
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const key = (body.apiKey ?? "").trim();
  if (!key) {
    return c.json({ ok: false, code: "missing", error: "Missing apiKey" }, 400);
  }
  if (!key.startsWith("sk-ant-")) {
    return c.json(
      {
        ok: false,
        code: "format",
        error: "API key must start with 'sk-ant-'. Copy it from console.anthropic.com.",
      },
      400
    );
  }

  info(`Validating API key (${maskKey(key)}) with Anthropic…`);
  const verdict = await validateAnthropicKey(key);

  if (!verdict.ok) {
    warn(`API key rejected (${verdict.code}): ${verdict.error}`);
    return c.json(
      { ok: false, code: verdict.code, status: verdict.status, error: verdict.error },
      verdict.code === "network" || verdict.code === "server" ? 502 : 400
    );
  }

  process.env.ANTHROPIC_API_KEY = key;
  info(`API key set (${maskKey(key)})`);

  return c.json({ ok: true, method: "api_key", masked: maskKey(key) });
}

/**
 * POST /api/auth/clear
 * Wipes the in-memory API key. Subscription auth (file-based) is untouched.
 */
export async function handleClearAuth(c: Context) {
  delete process.env.ANTHROPIC_API_KEY;
  logDebug("API key cleared");
  return c.json({ ok: true });
}

/**
 * Helper: detect which auth method is currently in use (used by /api/status).
 *   - "api_key"      → ANTHROPIC_API_KEY env var is set
 *   - "subscription" → ~/.claude/credentials.json exists (CLI logged in)
 *   - null           → no auth method available
 */
export function detectAuthMethod(): "api_key" | "subscription" | null {
  if (process.env.ANTHROPIC_API_KEY) return "api_key";

  const claudeDir = join(homedir(), ".claude");
  const credentialsPath = join(claudeDir, "credentials.json");
  const credentialsAltPath = join(claudeDir, ".credentials.json");
  if (existsSync(credentialsPath) || existsSync(credentialsAltPath)) {
    return "subscription";
  }

  return null;
}
