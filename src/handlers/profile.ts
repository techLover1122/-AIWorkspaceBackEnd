import type { Context } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";

/**
 * Profile avatar storage — one custom image per workspace (the owner).
 * Stored on the instance under ~/.ai-ide/profile/ so it persists across
 * restarts and is fetchable from both the desktop app and the web UI.
 *
 *   GET    /api/profile/avatar  → the stored image (404 if none → UI shows bot)
 *   POST   /api/profile/avatar  → multipart { file } image upload
 *   DELETE /api/profile/avatar  → remove custom image (revert to bot)
 */

const DIR = join(homedir(), ".ai-ide", "profile");
const IMG = join(DIR, "avatar.bin");
const TYPE = join(DIR, "avatar.type");
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export async function handleAvatarGet(c: Context): Promise<Response> {
  try {
    const buf = await readFile(IMG);
    const type = (await readFile(TYPE, "utf8").catch(() => "image/png")).trim() || "image/png";
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch {
    return c.json({ ok: false, error: "no avatar" }, 404);
  }
}

export async function handleAvatarUpload(c: Context): Promise<Response> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ ok: false, error: "Could not parse form data" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: "Missing file field" }, 400);
  }
  const type = file.type || "image/png";
  if (!ALLOWED.has(type)) {
    return c.json({ ok: false, error: "Unsupported image type" }, 400);
  }
  const ab = await file.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    return c.json({ ok: false, error: "Image too large (max 5 MB)" }, 400);
  }
  await mkdir(DIR, { recursive: true });
  await writeFile(IMG, Buffer.from(ab));
  await writeFile(TYPE, type);
  return c.json({ ok: true });
}

export async function handleAvatarDelete(c: Context): Promise<Response> {
  await unlink(IMG).catch(() => {});
  await unlink(TYPE).catch(() => {});
  return c.json({ ok: true });
}
