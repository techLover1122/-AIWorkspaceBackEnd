/**
 * Claude CLI path detection — Node-only, simplified.
 *
 * Tries (in order):
 *   1. CLAUDE_PATH env var
 *   2. `which`/`where` lookup on PATH
 *   3. Common npm/pnpm/Volta/asdf install locations
 *
 * Once a candidate is found, runs `<candidate> --version` to validate. The
 * resolved absolute path is returned (or undefined if nothing works).
 *
 * Adapted from claude-code-webui's validation.ts but without the Deno/Node
 * runtime abstraction and the PATH-wrapping trace technique — those add
 * complexity for the rare cases where the binary is found but its actual
 * script needs tracing. For our needs (running the SDK locally) the binary
 * path is sufficient.
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { info, debug as logDebug, warn, error as logError } from "./logger.js";

const execFileAsync = promisify(execFile);

const IS_WINDOWS = platform() === "win32";

/* ------------------------------------------------------------------
   Candidate generation
   ------------------------------------------------------------------ */

function commonInstallLocations(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (IS_WINDOWS) {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) {
      candidates.push(join(appData, "npm", "claude.cmd"));
      candidates.push(join(appData, "npm", "claude.ps1"));
    }
    if (localAppData) {
      candidates.push(join(localAppData, "Volta", "bin", "claude.exe"));
      candidates.push(join(localAppData, "Volta", "bin", "claude.cmd"));
    }
    candidates.push(join(home, "AppData", "Roaming", "npm", "claude.cmd"));
    candidates.push(join(home, ".volta", "bin", "claude.cmd"));
    candidates.push(join(home, ".asdf", "shims", "claude.cmd"));
  } else {
    candidates.push("/usr/local/bin/claude");
    candidates.push("/usr/bin/claude");
    candidates.push(join(home, ".npm-global", "bin", "claude"));
    candidates.push(join(home, ".volta", "bin", "claude"));
    candidates.push(join(home, ".asdf", "shims", "claude"));
    candidates.push(join(home, ".local", "bin", "claude"));
    candidates.push(join(home, ".nvm", "versions", "node", "*", "bin", "claude"));
  }

  return candidates.filter(existsSync);
}

function whichCommand(): string[] {
  const cmd = IS_WINDOWS ? "where" : "which";
  try {
    const result = spawnSync(cmd, ["claude"], { encoding: "utf-8" });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(existsSync);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------
   Validation: run --version
   ------------------------------------------------------------------ */

async function validate(candidate: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(candidate, ["--version"], {
      // The @anthropic-ai/claude-code wrapper does a one-time per-user binary
      // extract on first invocation that can take ~30s. cloud-init.sh warms
      // it for the ubuntu user at provision time, but on cold boots from
      // older snapshots (or any host where the warm-up was skipped) we need
      // headroom or detection false-fails and chat goes dead.
      timeout: 45000,
    });
    const version = stdout.trim();
    if (version) {
      logDebug(`Claude CLI candidate "${candidate}" → ${version}`);
      return version;
    }
    return null;
  } catch (err) {
    logDebug(
      `Candidate "${candidate}" rejected: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/* ------------------------------------------------------------------
   Public API
   ------------------------------------------------------------------ */

export interface ClaudeCliInfo {
  path: string;
  version: string;
}

/**
 * Resolve a working `claude` binary path. Returns null if no candidate
 * passes `--version`. Logs progress at info/debug levels.
 */
export async function detectClaudeCli(
  customPath?: string
): Promise<ClaudeCliInfo | null> {
  const candidates: string[] = [];

  // 1. Explicit user override
  if (customPath) {
    candidates.push(customPath);
  }

  // 2. CLAUDE_PATH env var
  if (process.env.CLAUDE_PATH) {
    candidates.push(process.env.CLAUDE_PATH);
  }

  // 3. PATH lookup
  candidates.push(...whichCommand());

  // 4. Common install locations
  candidates.push(...commonInstallLocations());

  // Dedupe (preserve order)
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c) ? false : seen.add(c)));

  if (unique.length === 0) {
    return null;
  }

  info(`🔍 Trying ${unique.length} Claude CLI candidate(s)…`);

  for (const candidate of unique) {
    const version = await validate(candidate);
    if (version) {
      info(`✅ Claude CLI: ${candidate} (${version})`);
      return { path: candidate, version };
    }
  }

  warn(
    `⚠️  None of the candidate Claude CLI paths worked. Tried:\n   ${unique.join("\n   ")}`
  );
  return null;
}

/**
 * Validate at startup and emit a clear warning if Claude isn't usable —
 * doesn't exit the process so the API stays up for diagnostics.
 */
export async function warmStartClaudeCli(customPath?: string): Promise<string | undefined> {
  const result = await detectClaudeCli(customPath);
  if (!result) {
    logError(
      "❌ Claude CLI not detected. Install with:\n" +
        "   npm install -g @anthropic-ai/claude-code\n" +
        "   claude login\n" +
        "Or pass --claude-path / CLAUDE_PATH to point at the binary."
    );
    return undefined;
  }
  return result.path;
}
