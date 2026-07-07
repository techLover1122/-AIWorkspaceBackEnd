import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promises as fsp, existsSync } from "node:fs";
import { info, warn } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// EBA Snapshot Guard — the 4th security layer
//
// Where the other three guards live:
//   1. Intent Guard      (intentGuardAgent.ts)   — pre-prompt
//   2. Tool Guard        (toolGuardAgent.ts)      — pre-tool, via canUseTool
//   3. Anomaly Detection (anomalyDetectionAgent.ts) — post-turn
//
// This one is a WATCHER that fires on the SDK PreToolUse hook. It runs even
// under `bypassPermissions` (unlike canUseTool, which the SDK skips in that
// mode — the default runtime), so it is the only reliable place to snapshot
// BEFORE every real edit.
//
// Behaviour:
//   • Read-only turn (Read / Grep / Glob / read-only Bash)  → NO snapshot.
//   • First code-CHANGE tool of the turn (Write / Edit / …)  → take a
//     whole-project snapshot of the working dir BEFORE the change runs, so the
//     pre-change state is recoverable.
//   • Retention: keep snapshots for 24h, then a background sweep deletes them.
//
// Scope: capture + retention only. Restore is a deliberate follow-up.
// ─────────────────────────────────────────────────────────────────────────────

// Snapshots live under the same durable root every other feature uses
// (~/.ai-ide/…), see utils/db.ts and handlers/office.ts.
const SNAPSHOT_ROOT =
  process.env.SNAPSHOT_DIR ?? join(homedir(), ".ai-ide", "snapshots");

// Keep each snapshot for 24 hours, then delete. House style: `N * … * 1000`.
const RETENTION_MS = 24 * 60 * 60 * 1000;

// Soft cap so a runaway project (or a mis-pointed cwd) can't copy forever.
const MAX_SNAPSHOT_BYTES = Number(
  process.env.SNAPSHOT_MAX_BYTES ?? 500 * 1024 * 1024
); // 500MB

// Feature kill-switch (set SNAPSHOT_DISABLED=true to turn the whole layer off).
const SNAPSHOT_DISABLED = process.env.SNAPSHOT_DISABLED === "true";

// Directories never worth snapshotting — heavy, regenerable, or VCS/tooling.
// Skipping these is what keeps a whole-project copy fast and small.
const IGNORE_DIRS = new Set<string>([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next",
  ".nuxt", ".cache", ".turbo", ".parcel-cache", "coverage", ".venv", "venv",
  "env", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "target", ".gradle", ".idea", ".vscode", "tmp", ".ai-ide",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Change detection — "is this tool about to modify code/files?"
// ─────────────────────────────────────────────────────────────────────────────

// Built-in SDK tools that deterministically write files on disk.
const FILE_EDIT_TOOLS = new Set<string>([
  "Write", "Edit", "MultiEdit", "NotebookEdit",
]);

// Conservative Bash mutation heuristic — only clear file-mutating commands
// trip this, so read-only Bash (ls / cat / grep / git status / git log) never
// forces a snapshot. Covers: redirection (> / >>), rm/rmdir/mv/cp/dd/truncate/
// tee/install/shred, sed -i, mkdir/touch/chmod/chown, mutating git subcommands,
// and package installs.
const BASH_MUTATION_RE =
  /(?:^|[\s;&|(])(?:rm|rmdir|mv|cp|dd|truncate|tee|shred|install)\s|>>?\s*[^|&\s]|\bsed\s+-i\b|\b(?:mkdir|touch|chmod|chown|ln)\b|\bgit\s+(?:reset|checkout|clean|rm|restore|apply|stash)\b|\b(?:npm|pnpm|yarn|pip|pip3|poetry)\s+(?:i|install|add|remove|uninstall|ci)\b/i;

/**
 * True when this tool call is about to CHANGE code/files on disk.
 * Read-only tools (Read, Grep, Glob, LS, read-only Bash) return false — those
 * take no snapshot, exactly as intended.
 */
export function isCodeChangeTool(toolName: string, toolInput: unknown): boolean {
  if (FILE_EDIT_TOOLS.has(toolName)) return true;
  if (toolName === "Bash") {
    const command =
      toolInput && typeof toolInput === "object" && "command" in toolInput
        ? String((toolInput as { command?: unknown }).command ?? "")
        : "";
    return BASH_MUTATION_RE.test(command);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture — whole-project snapshot taken BEFORE the change
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotMeta {
  id: string;
  taskId: string;
  cwd: string;
  /** Tool that triggered the snapshot (Write / Edit / Bash / …) */
  tool: string;
  createdAt: number;
  fileCount: number;
  byteCount: number;
  /** True if the copy stopped early because it hit MAX_SNAPSHOT_BYTES */
  truncated: boolean;
}

interface CopyBudget {
  bytes: number;
  files: number;
  cap: number;
}

/**
 * Recursively copy `srcDir` → `destDir`, skipping IGNORE_DIRS and symlinks and
 * enforcing a byte cap. Never throws on a single-file error — it skips and
 * logs — so one unreadable file can't abort the whole snapshot.
 */
async function copyTree(
  srcDir: string,
  destDir: string,
  budget: CopyBudget
): Promise<{ truncated: boolean }> {
  await fsp.mkdir(destDir, { recursive: true });

  let entries;
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true });
  } catch (e) {
    warn("Snapshot: cannot read dir, skipping:", { srcDir, error: String(e) });
    return { truncated: false };
  }

  for (const entry of entries) {
    if (budget.bytes >= budget.cap) return { truncated: true };

    const name = entry.name;
    const srcPath = join(srcDir, name);
    const destPath = join(destDir, name);

    // Never follow symlinks — avoids escaping the tree and cycle blow-ups.
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      const sub = await copyTree(srcPath, destPath, budget);
      if (sub.truncated) return { truncated: true };
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = (await fsp.stat(srcPath)).size;
      } catch {
        continue;
      }
      if (budget.bytes + size > budget.cap) return { truncated: true };
      try {
        await fsp.copyFile(srcPath, destPath);
        budget.bytes += size;
        budget.files += 1;
      } catch (e) {
        warn("Snapshot: failed to copy file, skipping:", {
          srcPath,
          error: String(e),
        });
      }
    }
  }

  return { truncated: false };
}

/**
 * Take a whole-project snapshot of `cwd` BEFORE a code change runs. One
 * snapshot captures the pre-change state of the entire working tree, so it is
 * taken once per turn (the caller gates on a per-turn flag).
 *
 * Safe to `await` inline in the PreToolUse hook: all errors are caught and
 * logged, never thrown, so a snapshot failure can NEVER block the agent's edit.
 * Returns the metadata on success, or null when skipped/failed.
 */
export async function captureProjectSnapshot(args: {
  taskId: string;
  cwd: string;
  tool: string;
}): Promise<SnapshotMeta | null> {
  const { taskId, cwd, tool } = args;

  if (SNAPSHOT_DISABLED) return null;

  // Guard: never snapshot a non-project root. WhatsApp turns fall back to the
  // user's HOME as cwd — snapshotting HOME (or /) would try to copy the whole
  // disk. Only snapshot a real, existing project directory.
  if (!cwd || !existsSync(cwd)) return null;
  const resolvedCwd = resolve(cwd);
  if (resolvedCwd === resolve(homedir()) || resolvedCwd === resolve("/")) {
    warn("EBA snapshot skipped — cwd is HOME/root, not a project:", {
      taskId,
      cwd: resolvedCwd,
    });
    return null;
  }

  const createdAt = Date.now();
  // id = `<epoch-ms>-<short-uuid>` so lexical sort == chronological and the
  // retention sweep can read the timestamp straight off the name.
  const id = `${createdAt}-${randomUUID().slice(0, 8)}`;
  const snapDir = join(SNAPSHOT_ROOT, id);
  const treeDir = join(snapDir, "tree");

  try {
    await fsp.mkdir(treeDir, { recursive: true });

    const budget: CopyBudget = { bytes: 0, files: 0, cap: MAX_SNAPSHOT_BYTES };
    const { truncated } = await copyTree(resolvedCwd, treeDir, budget);

    const meta: SnapshotMeta = {
      id,
      taskId,
      cwd: resolvedCwd,
      tool,
      createdAt,
      fileCount: budget.files,
      byteCount: budget.bytes,
      truncated,
    };
    await fsp.writeFile(
      join(snapDir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );

    info("EBA snapshot captured:", {
      id,
      taskId,
      tool,
      files: budget.files,
      mb: +(budget.bytes / 1024 / 1024).toFixed(1),
      truncated,
    });
    return meta;
  } catch (e) {
    warn("EBA snapshot capture failed (edit still proceeds):", {
      taskId,
      cwd: resolvedCwd,
      error: String(e),
    });
    // Best-effort cleanup of a half-written snapshot dir.
    try {
      await fsp.rm(snapDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention — delete snapshots older than 24h
// ─────────────────────────────────────────────────────────────────────────────

/** One sweep: delete every snapshot whose age >= RETENTION_MS. Exported for tests. */
export async function sweepExpiredSnapshots(now: number = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(SNAPSHOT_ROOT);
  } catch {
    // Root doesn't exist yet — nothing to sweep.
    return 0;
  }

  let evicted = 0;
  for (const name of entries) {
    // id format is `<epoch-ms>-<uuid8>` → parse the leading timestamp.
    const parsed = Number(name.split("-")[0]);
    let age: number;
    if (Number.isFinite(parsed) && parsed > 0) {
      age = now - parsed;
    } else {
      // Fallback to dir mtime for any unexpected name.
      try {
        age = now - (await fsp.stat(join(SNAPSHOT_ROOT, name))).mtimeMs;
      } catch {
        continue;
      }
    }
    if (age < RETENTION_MS) continue;

    try {
      await fsp.rm(join(SNAPSHOT_ROOT, name), { recursive: true, force: true });
      evicted += 1;
      info("EBA snapshot evicted (24h TTL):", { id: name, ageMs: age });
    } catch (e) {
      warn("EBA snapshot eviction failed:", { id: name, error: String(e) });
    }
  }
  return evicted;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the 24h retention sweep. Idempotent — safe to call once at boot.
 * Mirrors the taskRegistry idle-cleanup tick: 60s interval, `.unref()` so it
 * never keeps the Node process alive on its own.
 */
export function startSnapshotCleanup(): void {
  if (SNAPSHOT_DISABLED || sweepTimer) return;

  // Prune once on boot so a restart after downtime evicts immediately.
  void sweepExpiredSnapshots();

  sweepTimer = setInterval(() => {
    void sweepExpiredSnapshots();
  }, 60_000);
  sweepTimer.unref?.();

  info("EBA snapshot retention started:", {
    dir: SNAPSHOT_ROOT,
    retentionHours: RETENTION_MS / 3_600_000,
    maxMb: Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024),
  });
}
