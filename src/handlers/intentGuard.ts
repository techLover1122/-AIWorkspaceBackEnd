import type { Context } from "hono";
import { resolveIntentGuard } from "../middleware/intentGuardAgent.js";
import { info, warn } from "../utils/logger.js";

/**
 * POST /api/intent-guard/:id
 * Body: { choice: "narrow" | "broad" }
 *
 * Resolves a pending Intent Guard modal — the user chose which interpretation
 * of their ambiguous message to act on. The in-flight runIntentGuard() call
 * is waiting on this Promise; resolving it lets the chat task proceed with
 * the correct prompt prefix injected.
 */
export async function handleIntentGuardDecision(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) return c.json({ ok: false, error: "Missing id" }, 400);

  let body: { choice?: string };
  try {
    body = (await c.req.json()) as { choice?: string };
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const choice = body.choice;
  if (choice !== "narrow" && choice !== "broad") {
    return c.json({ ok: false, error: "choice must be 'narrow' or 'broad'" }, 400);
  }

  const resolved = resolveIntentGuard(id, choice);
  if (!resolved) {
    warn("Intent Guard decision for unknown/expired id:", { id });
    return c.json({ ok: false, error: "Unknown or already-resolved intent guard id" }, 404);
  }

  info("Intent Guard resolved:", { id, choice });
  return c.json({ ok: true });
}
