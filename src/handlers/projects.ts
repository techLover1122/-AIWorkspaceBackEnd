import { Context } from "hono";
import { readFile, access, readdir, stat } from "node:fs/promises";
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

export async function handleProjectsRequest(c: Context) {
  // The source of truth is `~/.claude/projects/<encoded>/*.jsonl`. The CLI
  // creates these dirs whenever a session is recorded, regardless of whether
  // `~/.claude.json` happens to also list the path under `projects` (newer
  // CLI builds omit that key entirely). We enumerate the directory listing
  // first, then enrich with authoritative paths from the config when it has
  // them — that way we never miss a session just because the config schema
  // changed.
  const byEncoded = new Map<string, ProjectInfo>();

  // 1. Directory listing (primary source).
  try {
    const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      byEncoded.set(entry.name, {
        path: decodeName(entry.name),
        encodedName: entry.name,
      });
    }
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
