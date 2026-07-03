import { Context, Next } from "hono";
import { sign, verify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { info, warn } from "../utils/logger.js";

/**
 * Enterprise sign-in — verifies username/password against the Odoo
 * instance this workspace ships with (read-only: we only call Odoo's own
 * /web/session/authenticate endpoint, exactly like its login page does;
 * nothing is ever written to the Odoo database), then mints a stateless
 * HS256 JWT so the workspace UI / desktop app can hold a session without
 * any user table of our own.
 *
 * Auth is OPT-IN: when AUTH_JWT_SECRET is unset (local dev, legacy
 * deployments) every request passes through untouched.
 */

const COOKIE_NAME = "aiide_token";
const TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 days — matches the platform desktop JWT

const AUTH_SECRET = () => process.env.AUTH_JWT_SECRET ?? "";
const ODOO_URL = () => process.env.ODOO_URL ?? "http://odoo:8069";
const ODOO_DB = () => process.env.ODOO_DB ?? "";

export function authEnabled(): boolean {
  return AUTH_SECRET().length > 0;
}

/** Paths that must stay reachable without a session. */
const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/logout",
  // ONLYOFFICE containers + editor assets authenticate with their own
  // OFFICE_JWT_SECRET; the editor page/iframe flow must not require our cookie.
  "/api/office/",
  "/api/plugin/",
  // Server-to-server webhook from the WhatsApp sidecar (token-checked inside).
  "/api/whatsapp/incoming",
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

type SessionClaims = { sub: string; uid: number; name: string; exp: number };

async function verifyToken(token: string): Promise<SessionClaims | null> {
  try {
    const payload = (await verify(token, AUTH_SECRET(), "HS256")) as unknown as SessionClaims;
    return payload?.sub ? payload : null;
  } catch {
    return null;
  }
}

function tokenFromRequest(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  if (/^bearer /i.test(header)) return header.slice(7).trim();
  return c.req.query("token") ?? getCookie(c, COOKIE_NAME) ?? "";
}

/**
 * Cookie options for the session. AUTH_COOKIE_DOMAIN (e.g. `.maesproject.com`)
 * widens the cookie to every subdomain so nginx `auth_request` can gate
 * sibling services (the embedded IDE) with the same sign-in.
 */
function sessionCookieOptions(c: Context) {
  const domain = process.env.AUTH_COOKIE_DOMAIN ?? "";
  return {
    path: "/",
    maxAge: TOKEN_TTL_S,
    sameSite: "Lax" as const,
    secure: (c.req.header("x-forwarded-proto") ?? "") === "https",
    ...(domain ? { domain } : {}),
  };
}

/**
 * Hono middleware gating every /api/* route (minus PUBLIC_PREFIXES) behind
 * a valid session token. Token sources: Authorization: Bearer, ?token=
 * (SSE/WS fallbacks), or the aiide_token cookie (the normal browser path).
 */
export async function enterpriseAuthMiddleware(c: Context, next: Next) {
  if (!authEnabled() || isPublicPath(c.req.path)) return next();
  const claims = await verifyToken(tokenFromRequest(c));
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  c.set("sessionUser", { login: claims.sub, uid: claims.uid, name: claims.name });
  return next();
}

/**
 * Used by the terminal WebSocket upgrade hook (plain node `http` request,
 * outside Hono). Accepts ?token= or the cookie header.
 */
export async function verifyUpgradeRequest(rawUrl: string, cookieHeader: string | undefined): Promise<boolean> {
  if (!authEnabled()) return true;
  const url = new URL(rawUrl, "http://localhost");
  let token = url.searchParams.get("token") ?? "";
  if (!token && cookieHeader) {
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    if (m) token = decodeURIComponent(m[1]);
  }
  return (await verifyToken(token)) !== null;
}

/** POST /api/auth/login — { login, password } verified against Odoo. */
export async function handleEnterpriseLogin(c: Context) {
  if (!authEnabled()) {
    return c.json({ error: "Enterprise auth is not configured on this workspace" }, 501);
  }
  let body: { login?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const login = (body.login ?? "").trim();
  const password = body.password ?? "";
  if (!login || !password) return c.json({ error: "Username and password are required" }, 400);

  // Fixed workspace credentials (AUTH_FIXED_USER / AUTH_FIXED_PASSWORD in
  // workspace.env) — checked first so the workspace works even when Odoo
  // is down; Odoo users are the fallback below.
  const fixedUser = process.env.AUTH_FIXED_USER ?? "";
  const fixedPass = process.env.AUTH_FIXED_PASSWORD ?? "";
  if (fixedUser && fixedPass && login === fixedUser && password === fixedPass) {
    const claims: SessionClaims = {
      sub: login,
      uid: 0,
      name: login,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
    };
    const token = await sign(claims as unknown as Record<string, unknown>, AUTH_SECRET());
    setCookie(c, COOKIE_NAME, token, sessionCookieOptions(c));
    info(`enterprise login ok (fixed workspace user): ${login}`);
    return c.json({ token, user: { login, uid: 0, name: login } });
  }

  let odooRes: Response;
  try {
    odooRes = await fetch(`${ODOO_URL()}/web/session/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        params: { db: ODOO_DB(), login, password },
      }),
    });
  } catch (err) {
    warn(`enterprise login: Odoo unreachable: ${err instanceof Error ? err.message : err}`);
    return c.json({ error: "Odoo is unreachable — try again shortly" }, 503);
  }

  let data: { result?: { uid?: number; name?: string; username?: string } };
  try {
    data = await odooRes.json();
  } catch {
    return c.json({ error: "Unexpected response from Odoo" }, 502);
  }
  if (!data.result?.uid) {
    info(`enterprise login rejected for "${login}"`);
    return c.json({ error: "Invalid username or password" }, 401);
  }

  const claims: SessionClaims = {
    sub: login,
    uid: data.result.uid,
    name: data.result.name ?? login,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
  };
  const token = await sign(claims as unknown as Record<string, unknown>, AUTH_SECRET());

  // Same-site cookie so every subsequent fetch/SSE/WS from the workspace UI
  // carries the session automatically. `secure` only when the request came
  // in over https (nginx sets x-forwarded-proto).
  setCookie(c, COOKIE_NAME, token, sessionCookieOptions(c));
  info(`enterprise login ok: ${login} (uid ${claims.uid})`);
  return c.json({ token, user: { login, uid: claims.uid, name: claims.name } });
}

/**
 * GET /api/auth/me — session probe for the UI gate.
 *  - auth disabled →  { authRequired: false }
 *  - valid session →  { authRequired: true, user }
 *  - otherwise     →  401
 */
export async function handleAuthMe(c: Context) {
  if (!authEnabled()) return c.json({ authRequired: false });
  const claims = await verifyToken(tokenFromRequest(c));
  if (!claims) return c.json({ authRequired: true, error: "unauthorized" }, 401);
  return c.json({ authRequired: true, user: { login: claims.sub, uid: claims.uid, name: claims.name } });
}

/** POST /api/auth/logout — clears the session cookie. Must pass the same
 *  Domain the cookie was set with, else the browser keeps the wider-domain
 *  cookie and the session survives. */
export async function handleAuthLogout(c: Context) {
  const domain = process.env.AUTH_COOKIE_DOMAIN ?? "";
  deleteCookie(c, COOKIE_NAME, { path: "/", ...(domain ? { domain } : {}) });
  return c.json({ ok: true });
}
