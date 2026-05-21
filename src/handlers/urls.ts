import type { Context } from "hono";
import {
  addUrl,
  listUrls,
  listOpenedUrls,
  deleteUrl,
  updateUrl,
  getUrl,
  getUrlByUrl,
  setUrlOpenedById,
  setUrlOpenedByUrl,
} from "../utils/db.js";
import { warn } from "../utils/logger.js";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function resolveIconUrl(iconHref: string, pageUrl: string): string {
  try {
    if (iconHref.startsWith("//")) {
      const protocol = new URL(pageUrl).protocol;
      return `${protocol}${iconHref}`;
    }
    if (iconHref.startsWith("http://") || iconHref.startsWith("https://") || iconHref.startsWith("data:")) {
      return iconHref;
    }
    return new URL(iconHref, pageUrl).toString();
  } catch {
    return iconHref;
  }
}

/** Fetch the URL, parse <title> and the best favicon <link>. */
async function extractMetadata(url: string): Promise<{ title: string | null; icon: string | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 AI-IDE-Bookmark/1.0",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });
    clearTimeout(t);

    const html = await res.text();

    // <title>
    let title: string | null = null;
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm) title = decodeEntities(tm[1].trim()).slice(0, 200);

    // favicon — pick the highest-priority match (apple-touch-icon > icon > shortcut icon)
    const linkRegex = /<link\b[^>]*>/gi;
    const candidates: { href: string; rel: string; sizes: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRegex.exec(html))) {
      const tag = m[0];
      const relMatch = tag.match(/\brel=["']([^"']+)["']/i);
      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (!relMatch || !hrefMatch) continue;
      const rel = relMatch[1].toLowerCase();
      if (!/icon/.test(rel)) continue;
      const sizesMatch = tag.match(/\bsizes=["']?(\d+)/i);
      candidates.push({
        href: hrefMatch[1],
        rel,
        sizes: sizesMatch ? parseInt(sizesMatch[1], 10) : 16,
      });
    }
    let icon: string | null = null;
    if (candidates.length) {
      const priority = (c: { rel: string; sizes: number }) =>
        (c.rel.includes("apple-touch") ? 1000 : 0) + c.sizes;
      candidates.sort((a, b) => priority(b) - priority(a));
      icon = resolveIconUrl(candidates[0].href, url);
    } else {
      // fall back to /favicon.ico
      try {
        const u = new URL(url);
        icon = `${u.protocol}//${u.host}/favicon.ico`;
      } catch { /* ignore */ }
    }

    return { title, icon };
  } catch (err) {
    clearTimeout(t);
    warn(`Metadata extract failed for ${url}: ${err instanceof Error ? err.message : err}`);
    return { title: null, icon: null };
  }
}

/* ---------- Handlers ---------- */

export async function handleAddUrl(c: Context) {
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string;
    name?: string;
    icon?: string;
  };
  if (!body.url) return c.json({ error: "url required" }, 400);

  let url = body.url.trim();
  // If user typed a bare port "5173" or "localhost:5173", normalize
  if (/^\d+$/.test(url)) url = `http://localhost:${url}`;
  else if (!/^https?:\/\//i.test(url)) url = `http://${url}`;

  let name = body.name ?? null;
  let icon = body.icon ?? null;

  // If this URL already has both name and icon in the DB, skip the network fetch.
  const existing = getUrlByUrl(url);
  const haveFullExisting = existing && existing.name && existing.icon;

  if (!haveFullExisting && (!name || !icon)) {
    const meta = await extractMetadata(url);
    if (!name) name = meta.title;
    if (!icon) icon = meta.icon;
  }

  const row = addUrl(url, name, icon);
  return c.json({ url: row });
}

export function handleListUrls(c: Context) {
  return c.json({ urls: listUrls() });
}

export function handleDeleteUrl(c: Context) {
  const idStr = c.req.param("id");
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  deleteUrl(id);
  return c.json({ ok: true });
}

export async function handleRefreshUrl(c: Context) {
  const idStr = c.req.param("id");
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const row = getUrl(id);
  if (!row) return c.json({ error: "not found" }, 404);
  const meta = await extractMetadata(row.url);
  updateUrl(id, meta.title, meta.icon);
  return c.json({ url: getUrl(id) });
}

export function handleListOpenedUrls(c: Context) {
  return c.json({ urls: listOpenedUrls() });
}

/** Body: { id?: number, url?: string, opened: boolean } */
export async function handleSetOpened(c: Context) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    url?: string;
    opened?: boolean;
  };
  if (typeof body.opened !== "boolean") {
    return c.json({ error: "opened (boolean) required" }, 400);
  }
  if (typeof body.id === "number") {
    setUrlOpenedById(body.id, body.opened);
    return c.json({ ok: true });
  }
  if (typeof body.url === "string" && body.url) {
    setUrlOpenedByUrl(body.url, body.opened);
    return c.json({ ok: true });
  }
  return c.json({ error: "id or url required" }, 400);
}
