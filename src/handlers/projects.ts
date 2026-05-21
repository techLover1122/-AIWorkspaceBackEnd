import { Context } from "hono";
import { readFile, access, readdir, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectInfo } from "../types.js";

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Claude CLI saves history dirs as path-with-dashes (`:`, `/`, `\` → `-`). */
function encodeName(name: string): string {
  return name.replace(/[:\/\\]/g, "-");
}

/**
 * Best-effort reverse of {@link encodeName} for display. The encoder is lossy
 * (literal `-` chars in segment names are indistinguishable from separators),
 * so this can't be perfect — but it gives the user a recognizable path.
 *
 * Heuristics:
 *  - `^[A-Za-z]--…`  → Windows drive (`d--foo-bar` → `D:\foo\bar`)
 *  - `^-…`           → POSIX absolute (`-home-user-foo` → `/home/user/foo`)
 *  - otherwise       → leave as-is.
 */
function decodeName(encoded: string): string {
  const drive = encoded.match(/^([A-Za-z])--(.*)$/);
  if (drive) {
    const rest = drive[2].replace(/-/g, "\\");
    return `${drive[1].toUpperCase()}:\\${rest}`;
  }
  if (encoded.startsWith("-")) {
    return "/" + encoded.slice(1).replace(/-/g, "/");
  }
  return encoded;
}

/**
 * Pull the authoritative `cwd` from the most recent jsonl in a project dir.
 * The Claude CLI records the original working directory on most history
 * lines, which lets us round-trip names like `d--Working-AI-IDE` back to
 * `d:\Working\AI-IDE` (literal dashes survive — the heuristic decoder
 * mangles them). Reads only a 16KB head from one file, so it stays cheap.
 */
async function findCwdFromHistory(historyDir: string): Promise<string | null> {
  let files: string[];
  try {
    files = (await readdir(historyDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // Pick the most recently modified jsonl — likeliest to reflect the
  // current cwd if the project moved.
  let chosen = files[0];
  let chosenMtime = 0;
  for (const f of files) {
    try {
      const s = await stat(join(historyDir, f));
      if (s.mtimeMs > chosenMtime) {
        chosenMtime = s.mtimeMs;
        chosen = f;
      }
    } catch {
      /* skip */
    }
  }

  let fh;
  try {
    fh = await open(join(historyDir, chosen), "r");
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.toString("utf-8", 0, bytesRead);
    for (const line of head.split("\n")) {
      if (!line) continue;
      // Avoid parsing a truncated last line.
      if (!line.startsWith("{") || !line.trim().endsWith("}")) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === "string" && obj.cwd.length > 0) return obj.cwd;
      } catch {
        /* malformed line — keep scanning */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function handleProjectsRequest(c: Context) {
  // The source of truth is `~/.claude/projects/<encoded>/*.jsonl`. The CLI
  // creates these dirs whenever a session is recorded, regardless of whether
  // `~/.claude.json` happens to also list the path under `projects` (newer
  // CLI builds omit that key entirely). We enumerate the directory listing
  // first, then enrich with authoritative paths from the config when it has
  // them — that way we never miss a session just because the config schema
  // changed.
  const byEncoded = new Map<string, ProjectInfo>();

  // 1. Directory listing (primary source). For each project, try to recover
  //    the original cwd from its jsonl history so we get a precise display
  //    path; fall back to the lossy heuristic decode if that fails.
  try {
    const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    const resolved = await Promise.all(
      dirs.map(async (e) => {
        const cwd = await findCwdFromHistory(join(CLAUDE_PROJECTS_DIR, e.name));
        return {
          encodedName: e.name,
          path: cwd ?? decodeName(e.name),
        };
      })
    );
    for (const info of resolved) byEncoded.set(info.encodedName, info);
  } catch {
    // No projects dir yet — fall through to config-only path below.
  }

  // 2. Enrich with exact paths from `.claude.json` when present (handles both
  //    the legacy array form and the current object-keyed-by-path form).
  try {
    await access(CLAUDE_CONFIG_PATH);
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const projectsField = config.projects ?? config.projectPaths;
    let projectPaths: string[] = [];
    if (Array.isArray(projectsField)) {
      projectPaths = projectsField.filter((p): p is string => typeof p === "string");
    } else if (projectsField && typeof projectsField === "object") {
      projectPaths = Object.keys(projectsField);
    }

    for (const projectPath of projectPaths) {
      const encodedName = encodeName(projectPath);
      const existing = byEncoded.get(encodedName);
      if (existing) {
        // Replace the heuristic-decoded path with the authoritative one.
        existing.path = projectPath;
      } else {
        // Config knows about it but no history dir exists yet — verify the
        // dir actually exists before showing it (avoids dead entries).
        try {
          const s = await stat(join(CLAUDE_PROJECTS_DIR, encodedName));
          if (s.isDirectory()) {
            byEncoded.set(encodedName, { path: projectPath, encodedName });
          }
        } catch {
          /* no history dir for this project — skip */
        }
      }
    }
  } catch {
    /* config unreadable — directory listing is enough */
  }

  const projects = Array.from(byEncoded.values()).sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  return c.json({ projects });
}
