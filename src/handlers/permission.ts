import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { warn, info } from "../utils/logger.js";

/**
 * Bridge between the SDK's `canUseTool` callback (which runs inside the
 * backend SDK call) and the frontend permission UI.
 *
 * Flow:
 *   1. SDK calls canUseTool for a not-yet-allowed tool.
 *   2. canUseTool creates a pending Promise here and emits a
 *      `permission_request` stream event with structured fields.
 *   3. Frontend renders the permission UI and POSTs the user's decision
 *      to /api/permission/:id.
 *   4. handlePermissionDecision resolves the pending Promise.
 *   5. canUseTool returns the PermissionResult → SDK proceeds.
 *
 * The Map keys are stable within the process lifetime. Pending entries are
 * cleaned up on resolve, on stream abort, and on backend restart.
 */

type Pending = {
  resolve: (result: PermissionResult) => void;
  toolUseId: string;
  toolName: string;
  /** Original tool input — fed back as `updatedInput` on allow because the
   *  SDK's runtime Zod schema rejects allow results without it (despite the
   *  TS type marking it optional). */
  input: Record<string, unknown>;
  createdAt: number;
};

const pending = new Map<string, Pending>();

export type PermissionRequestPayload = {
  /** Server-generated id used to resolve via POST /api/permission/:id */
  id: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  suggestions?: PermissionUpdate[];
};

export function createPendingPermission(args: {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}): {
  id: string;
  promise: Promise<PermissionResult>;
} {
  const id = randomUUID();
  const promise = new Promise<PermissionResult>((resolve) => {
    pending.set(id, {
      resolve,
      toolUseId: args.toolUseId,
      toolName: args.toolName,
      input: args.input,
      createdAt: Date.now(),
    });
  });
  return { id, promise };
}

/** Auto-deny + cleanup. Used on stream abort or timeout. */
export function denyPending(id: string, message: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve({ behavior: "deny", message });
  return true;
}

/**
 * POST /api/permission/:id
 * Body: PermissionResult-shaped object:
 *   { behavior: "allow", updatedInput?, updatedPermissions? }
 *   { behavior: "deny", message }
 */
export async function handlePermissionDecision(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) return c.json({ ok: false, error: "Missing id" }, 400);

  let body: Partial<PermissionResult> & { behavior?: string; message?: string };
  try {
    body = (await c.req.json()) as Partial<PermissionResult> & {
      behavior?: string;
      message?: string;
    };
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const entry = pending.get(id);
  if (!entry) {
    warn("Permission decision for unknown/expired id:", { id });
    return c.json({ ok: false, error: "Unknown or already-resolved permission id" }, 404);
  }
  pending.delete(id);

  if (body.behavior === "allow") {
    info("Permission decision: ALLOW", {
      id,
      tool: entry.toolName,
      tool_use_id: entry.toolUseId,
      hasUpdatedPermissions: Array.isArray((body as { updatedPermissions?: unknown }).updatedPermissions),
    });
    // SDK's runtime Zod schema requires `updatedInput` to be present on the
    // allow branch (despite the TS type marking it optional). When the
    // frontend doesn't send a modified input, pass the original tool input
    // back unchanged so validation succeeds.
    const updatedInput =
      (body as { updatedInput?: Record<string, unknown> }).updatedInput ?? entry.input;
    entry.resolve({
      behavior: "allow",
      updatedInput,
      ...((body as { updatedPermissions?: PermissionUpdate[] }).updatedPermissions
        ? {
            updatedPermissions: (body as { updatedPermissions?: PermissionUpdate[] })
              .updatedPermissions,
          }
        : {}),
    });
  } else {
    info("Permission decision: DENY", {
      id,
      tool: entry.toolName,
      tool_use_id: entry.toolUseId,
      message: body.message,
    });
    entry.resolve({
      behavior: "deny",
      message: body.message ?? "Denied by user",
    });
  }

  return c.json({ ok: true });
}

/** Diagnostic helper — current pending count. */
export function pendingCount(): number {
  return pending.size;
}
