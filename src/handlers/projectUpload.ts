import type { Context } from "hono";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { info, warn } from "../utils/logger.js";

/**
 * POST /api/files/upload?workingDirectory=<path>
 *
 * Accepts multipart/form-data:
 *   paths  — JSON-encoded string[], one relative path per file
 *            (e.g. ["myapp/src/index.ts", "myapp/logo.png"])
 *   file_0 — binary of paths[0]
 *   file_1 — binary of paths[1]
 *   …
 *
 * Each file is written to <workingDirectory>/<relativePath>, creating
 * directories as needed.  Folder structure is preserved exactly.
 *
 * Returns { ok: true, count: N } on success.
 */

const HOME_DIR = homedir();
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB total per request

/** Strip path-traversal and absolute-path attacks from a relative path. */
function safePath(raw: string): string | null {
  const norm = raw.replace(/\\/g, "/").trim();
  if (!norm) return null;
  if (norm.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(norm)) return null; // Windows absolute
  if (norm.split("/").some((seg) => seg === "..")) return null;
  return norm;
}

export async function handleFileUpload(c: Context): Promise<Response> {
  const rawWd = c.req.query("workingDirectory");
  const targetDir =
    rawWd && rawWd.trim() ? rawWd.trim() : join(HOME_DIR, ".ai-ide", "uploads");

  // Only allow writing inside the home directory.
  if (!targetDir.startsWith(HOME_DIR)) {
    return c.json({ ok: false, error: "workingDirectory must be within home directory" }, 403);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ ok: false, error: "Could not parse multipart form data" }, 400);
  }

  const rawPaths = formData.get("paths");
  if (typeof rawPaths !== "string") {
    return c.json({ ok: false, error: "Missing paths field" }, 400);
  }

  let paths: string[];
  try {
    paths = JSON.parse(rawPaths) as string[];
    if (!Array.isArray(paths)) throw new Error("paths must be an array");
  } catch {
    return c.json({ ok: false, error: "Invalid paths field — expected JSON array" }, 400);
  }

  if (paths.length === 0) {
    return c.json({ ok: false, error: "No files provided" }, 400);
  }

  // Collect all files and validate total size.
  const files: File[] = [];
  let totalBytes = 0;
  for (let i = 0; i < paths.length; i++) {
    const f = formData.get(`file_${i}`);
    if (!(f instanceof File)) {
      return c.json({ ok: false, error: `Missing file_${i}` }, 400);
    }
    totalBytes += f.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return c.json(
        { ok: false, error: `Upload exceeds ${MAX_TOTAL_BYTES / 1024 / 1024} MB` },
        413
      );
    }
    files.push(f);
  }

  // Write each file to disk.
  let count = 0;
  for (let i = 0; i < files.length; i++) {
    const relPath = safePath(paths[i]);
    if (!relPath) {
      warn(`[file-upload] skipping unsafe path: ${paths[i]}`);
      continue;
    }

    const dest = join(targetDir, relPath);

    // Extra safety: dest must still be inside targetDir after resolution.
    if (!dest.startsWith(targetDir)) {
      warn(`[file-upload] skipping path that escapes targetDir: ${dest}`);
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    const buf = Buffer.from(await files[i].arrayBuffer());
    await writeFile(dest, buf);
    count++;
    info(`[file-upload] ${basename(dest)} → ${dest}`);
  }

  return c.json({ ok: true, count });
}
