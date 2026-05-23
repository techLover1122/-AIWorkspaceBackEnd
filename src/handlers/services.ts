import type { Context } from "hono";
import { warn } from "../utils/logger.js";

/**
 * Service registration / listing.
 *
 * Owns no local state — every call is a thin passthrough to the
 * traefik-router on the proxy EC2, which holds the authoritative
 * workspaceservices collection in Mongo. The router is also what Traefik
 * polls for routing, so a successful POST here is reflected in the proxy
 * within one poll cycle (≤5s).
 *
 * Required env (written by terraform/workspace/user-data.sh.tftpl):
 *   - PROXY_ROUTER_URL  e.g. http://<proxy-dns>:9100
 *   - USER_ID           the workspace owner's Mongo _id (24-char hex)
 */

function routerBase(): string | null {
  const base = process.env.PROXY_ROUTER_URL;
  const uid = process.env.USER_ID;
  if (!base || !uid) return null;
  return `${base.replace(/\/+$/, "")}/api/services/${uid}`;
}

export interface RegisteredService {
  name: string;
  port: number;
  url: string;
}

/** Register a port as a service. Idempotent — safe to call repeatedly. */
export async function registerServicePort(
  port: number,
  name?: string
): Promise<RegisteredService | null> {
  const base = routerBase();
  if (!base) {
    warn("PROXY_ROUTER_URL / USER_ID not set — service registration skipped");
    return null;
  }
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name ? { port, name } : { port }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      warn(`registerServicePort: ${res.status} ${txt}`);
      return null;
    }
    return (await res.json()) as RegisteredService;
  } catch (err) {
    warn(`registerServicePort: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/* ---------- Hono handlers ---------- */

export async function handleRegisterService(c: Context) {
  const body = (await c.req.json().catch(() => null)) as
    | { port?: unknown; name?: unknown }
    | null;
  if (!body) return c.json({ error: "invalid json body" }, 400);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return c.json({ error: "port must be an integer 1-65535" }, 400);
  }
  const name = typeof body.name === "string" ? body.name : undefined;

  const result = await registerServicePort(port, name);
  if (!result) {
    return c.json(
      { error: "registration failed — see workspace logs" },
      502
    );
  }
  return c.json(result);
}

export async function handleListServices(c: Context) {
  const base = routerBase();
  if (!base) return c.json({ services: [] });
  try {
    const res = await fetch(base, { method: "GET" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      warn(`handleListServices: ${res.status} ${txt}`);
      return c.json({ services: [] });
    }
    const data = (await res.json()) as { services?: RegisteredService[] };
    return c.json({ services: data.services ?? [] });
  } catch (err) {
    warn(`handleListServices: ${err instanceof Error ? err.message : err}`);
    return c.json({ services: [] });
  }
}
