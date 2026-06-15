import type { Context } from "hono";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  mkdir,
  rm,
  readdir,
  stat,
  rename,
  cp,
  access,
  readFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import { warn } from "../utils/logger.js";
import { publishEvent } from "./events.js";

function parseSkillDescription(skillMd: string): string {
  const fmMatch = skillMd.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return "";
  const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
  if (!descMatch) return "";
  return descMatch[1].trim().replace(/^["']|["']$/g, "");
}

type Source = "github" | "zip" | "git";

type InstallStep = { t: number; msg: string };

type SuccessResponse = {
  ok: true;
  name: string;
  slug: string;
  description: string;
  hasInstall: boolean;
  source: Source;
  installedAt: string;
  steps: InstallStep[];
};

type ErrorCode =
  | "bad_request"
  | "bad_url"
  | "no_skill_md"
  | "exists"
  | "git_missing"
  | "git_failed"
  | "download_failed"
  | "extract_failed"
  | "move_failed"
  | "internal";

type ErrorResponse = {
  ok: false;
  code: ErrorCode;
  error: string;
  steps?: InstallStep[];
};

const GITHUB_REPO_RE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

function detectSource(rawUrl: string): { source: Source; url: URL } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return null;
  }
  if (url.hostname === "github.com" && GITHUB_REPO_RE.test(url.pathname)) {
    return { source: "github", url };
  }
  if (url.pathname.toLowerCase().endsWith(".zip")) {
    return { source: "zip", url };
  }
  return { source: "git", url };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "pack"
  );
}

function parseSkillName(skillMd: string): string | null {
  const fmMatch = skillMd.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  return nameMatch[1].trim().replace(/^["']|["']$/g, "");
}

/** Pull one scalar frontmatter field (unquoted). */
function fmField(frontmatter: string, key: string): string | undefined {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

export type PackInfo = {
  slug: string;
  name: string;
  description: string;
  /** Optional app metadata a pack may declare in its SKILL.md frontmatter. */
  icon?: string;
  color?: string;
  category?: string;
  port?: number;
  homepage?: string;
  /** Whether the underlying tool/app is actually present on the system —
   *  resolved by running the pack's check command (frontmatter `check:` or a
   *  built-in for known packs). undefined = unknown (no check available). */
  installed?: boolean;
};

/* Built-in "is it installed?" probes for well-known packs that have no web
 * port to detect (CLI tools, dev environments). A pack can override/add its
 * own by declaring `check:` in SKILL.md frontmatter. Exit 0 = installed. */
const BUILTIN_CHECKS: { keys: string[]; cmd: string }[] = [
  { keys: ["hyperframe"], cmd: "docker exec ai-ide-playwright sh -lc 'command -v hyperframes' >/dev/null 2>&1" },
  { keys: ["gemini", "imagen"], cmd: "docker exec ai-ide-playwright test -f /opt/hyperframes/generate_asset.py" },
  { keys: ["web-dev", "web dev", "webdev", "fullstack"], cmd: "command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1" },
  { keys: ["dotnet", ".net"], cmd: "command -v dotnet >/dev/null 2>&1" },
  { keys: ["playwright"], cmd: "docker ps --format '{{.Names}}' | grep -qx ai-ide-playwright" },
];

function builtinCheckFor(slug: string, name: string): string | undefined {
  const hay = `${slug} ${name}`.toLowerCase();
  return BUILTIN_CHECKS.find((c) => c.keys.some((k) => hay.includes(k)))?.cmd;
}

/** Run a shell check command; resolve true on exit 0, false otherwise (incl.
 *  timeout / missing shell). Best-effort — never throws. */
function runCheck(cmd: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn("bash", ["-lc", cmd], { windowsHide: true });
    } catch {
      return finish(false);
    }
    const t = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(t);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      finish(code === 0);
    });
  });
}

/**
 * GET /api/packs
 *
 * Lists every environment pack installed at ~/.claude/skills/ (folders with a
 * SKILL.md). The App Store renders one card per pack. Beyond name/description
 * we surface any optional app metadata a pack declares in its frontmatter
 * (icon, color, category, port, homepage) so packs can present as polished
 * apps without code changes.
 */
export async function handleListPacks(c: Context): Promise<Response> {
  const skillsRoot = join(homedir(), ".claude", "skills");
  const packs: PackInfo[] = [];
  const checkCmds = new Map<string, string | undefined>();
  let slugs: string[] = [];
  try {
    slugs = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return c.json({ packs: [] });
  }

  for (const slug of slugs) {
    const skillMd = join(skillsRoot, slug, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillMd, "utf8");
    } catch {
      continue; // no SKILL.md → not a pack
    }
    const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    const frontmatter = fm ? fm[1] : "";
    const portRaw = fmField(frontmatter, "port");
    const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : undefined;
    const name = fmField(frontmatter, "name") ?? slug;
    packs.push({
      slug,
      name,
      description: parseSkillDescription(content),
      icon: fmField(frontmatter, "icon"),
      color: fmField(frontmatter, "color"),
      category: fmField(frontmatter, "category"),
      port,
      homepage: fmField(frontmatter, "homepage"),
    });
    // Stash the check command alongside (frontmatter `check:` wins, else a
    // built-in for known packs). Resolved against the system below.
    checkCmds.set(slug, fmField(frontmatter, "check") ?? builtinCheckFor(slug, name));
  }

  // Probe the system for each pack that has a check command (parallel).
  await Promise.all(
    packs.map(async (p) => {
      const cmd = checkCmds.get(p.slug);
      if (cmd) p.installed = await runCheck(cmd);
    })
  );

  packs.sort((a, b) => a.slug.localeCompare(b.slug));
  return c.json({ packs });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(p: string): Promise<string[]> {
  const entries = await readdir(p, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Walk one level deep to find a folder containing SKILL.md. */
async function findPackRoot(stagingDir: string): Promise<string | null> {
  if (await pathExists(join(stagingDir, "SKILL.md"))) return stagingDir;
  const children = await readdir(stagingDir, { withFileTypes: true });
  const dirs = children.filter((c) => c.isDirectory());
  for (const d of dirs) {
    const candidate = join(stagingDir, d.name);
    if (await pathExists(join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

function runGitClone(repoUrl: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", "--depth=1", repoUrl, target], {
      windowsHide: true,
      shell: false,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(Object.assign(new Error("git not found on PATH"), { code: "git_missing" as const }));
      } else {
        reject(Object.assign(new Error(err.message), { code: "git_failed" as const }));
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          Object.assign(new Error(stderr.trim() || `git clone exited with code ${code}`), {
            code: "git_failed" as const,
          })
        );
    });
  });
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), {
      code: "download_failed" as const,
    });
  }
  const body = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  await pipeline(body, createWriteStream(dest));
}

async function downloadGithubRepoZip(user: string, repo: string, destZip: string): Promise<void> {
  // Try common default branches in order.
  const branches = ["HEAD", "main", "master"];
  let lastErr: unknown = null;
  for (const ref of branches) {
    const url = `https://codeload.github.com/${user}/${repo}/zip/refs/heads/${ref}`;
    try {
      await downloadToFile(url, destZip);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  // Fallback: GitHub's redirecting endpoint that resolves the default branch.
  try {
    await downloadToFile(`https://github.com/${user}/${repo}/archive/HEAD.zip`, destZip);
    return;
  } catch (err) {
    lastErr = err;
  }
  throw lastErr ?? Object.assign(new Error("GitHub download failed"), { code: "download_failed" as const });
}

function extractZip(zipPath: string, dest: string): void {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dest, /* overwrite */ true);
}

/**
 * POST /api/packs/install
 * Body: { url: string }
 *
 * Fetches an "environment pack" (a Claude-Code-style skill folder containing
 * SKILL.md and optionally INSTALL.md) from a GitHub repo URL, raw .zip URL,
 * or any git-clonable URL, then installs it into ~/.claude/skills/<slug>/.
 *
 * Discovery is handled by Claude Code's built-in Skill tool — we do not
 * mutate CLAUDE.md.
 */
export async function handleInstallPack(c: Context): Promise<Response> {
  const steps: InstallStep[] = [];
  const log = (msg: string) => {
    steps.push({ t: Date.now(), msg });
  };

  let body: { url?: unknown };
  try {
    body = (await c.req.json()) as { url?: unknown };
  } catch {
    return c.json<ErrorResponse>(
      { ok: false, code: "bad_request", error: "Invalid JSON body" },
      400
    );
  }

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) {
    return c.json<ErrorResponse>(
      { ok: false, code: "bad_request", error: "Missing url field" },
      400
    );
  }

  const detected = detectSource(rawUrl);
  if (!detected) {
    return c.json<ErrorResponse>(
      { ok: false, code: "bad_url", error: "URL must be a public https:// link" },
      400
    );
  }

  const { source, url } = detected;
  log(`Resolved source: ${source}`);

  const tempRoot = join(tmpdir(), `jetro-pack-${randomBytes(6).toString("hex")}`);
  await mkdir(tempRoot, { recursive: true });

  try {
    // 1) Fetch the pack contents into a staging directory.
    const stagingDir = join(tempRoot, "staging");
    await mkdir(stagingDir, { recursive: true });

    if (source === "github") {
      const m = url.pathname.match(GITHUB_REPO_RE);
      if (!m) throw Object.assign(new Error("Invalid GitHub repo URL"), { code: "bad_url" as const });
      const [, user, repo] = m;
      log(`Downloading ${user}/${repo} from GitHub…`);
      const zipPath = join(tempRoot, "pack.zip");
      await downloadGithubRepoZip(user, repo, zipPath);
      log("Extracting…");
      extractZip(zipPath, stagingDir);
    } else if (source === "zip") {
      log("Downloading .zip…");
      const zipPath = join(tempRoot, "pack.zip");
      await downloadToFile(url.toString(), zipPath);
      log("Extracting…");
      extractZip(zipPath, stagingDir);
    } else {
      log(`Cloning ${url.toString()}…`);
      await runGitClone(url.toString(), join(stagingDir, "repo"));
    }

    // 2) Locate the pack root (folder containing SKILL.md).
    log("Locating SKILL.md…");
    let packRoot = await findPackRoot(stagingDir);

    // ZIPs often nest under a single top-level dir (e.g. repo-main/). Descend
    // one more level if needed.
    if (!packRoot) {
      const dirs = await listDirs(stagingDir);
      if (dirs.length === 1) {
        const deeper = await findPackRoot(join(stagingDir, dirs[0]));
        if (deeper) packRoot = deeper;
      }
    }

    if (!packRoot) {
      return c.json<ErrorResponse>(
        {
          ok: false,
          code: "no_skill_md",
          error: "No SKILL.md found in the downloaded pack",
          steps,
        },
        400
      );
    }

    // 3) Determine pack name + slug.
    const skillMdContent = await readFile(join(packRoot, "SKILL.md"), "utf8");
    const parsedName = parseSkillName(skillMdContent);
    const fallbackName =
      source === "github"
        ? (url.pathname.match(GITHUB_REPO_RE)?.[2] ?? "pack")
        : basename(url.pathname, ".zip") || "pack";
    const name = parsedName ?? fallbackName;
    const slug = slugify(name);
    log(`Pack name: ${name} (slug: ${slug})`);

    // 4) Compute target and check for conflict.
    const skillsRoot = join(homedir(), ".claude", "skills");
    await mkdir(skillsRoot, { recursive: true });
    const target = join(skillsRoot, slug);

    if (await pathExists(target)) {
      return c.json<ErrorResponse>(
        {
          ok: false,
          code: "exists",
          error: `An environment pack named "${slug}" is already installed at ${target}. Delete it first or pick a different name.`,
          steps,
        },
        409
      );
    }

    // 5) Move pack root → target.
    log(`Installing to ${target}…`);
    try {
      await rename(packRoot, target);
    } catch (err) {
      // EXDEV (cross-device link) or similar — fall back to copy.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV" || code === "EPERM") {
        await cp(packRoot, target, { recursive: true });
      } else {
        throw Object.assign(new Error(`Failed to move pack: ${(err as Error).message}`), {
          code: "move_failed" as const,
        });
      }
    }

    // 6) Detect INSTALL.md at target.
    const hasInstall = await pathExists(join(target, "INSTALL.md"));
    log(hasInstall ? "INSTALL.md detected" : "No INSTALL.md (skipping install prompt)");

    // 7) Re-read the moved SKILL.md to pull the description (used by the
    // SSE event so any chat path — modal, CLI, API — gets a complete
    // notification for the AI to act on).
    let description = parseSkillDescription(skillMdContent);
    if (!description) {
      // Re-parse from the now-moved file in case the original was empty.
      try {
        const movedSkill = await readFile(join(target, "SKILL.md"), "utf8");
        description = parseSkillDescription(movedSkill);
      } catch { /* ignore */ }
    }

    publishEvent({
      type: "pack_installed",
      name,
      slug,
      description,
      hasInstall,
      installedAt: target,
    });

    const result: SuccessResponse = {
      ok: true,
      name,
      slug,
      description,
      hasInstall,
      source,
      installedAt: target,
      steps,
    };
    return c.json(result);
  } catch (err) {
    const code =
      (err as { code?: ErrorCode }).code &&
      ["git_missing", "git_failed", "download_failed", "extract_failed", "bad_url"].includes(
        (err as { code?: string }).code as string
      )
        ? ((err as { code: ErrorCode }).code)
        : "internal";
    const msg = err instanceof Error ? err.message : String(err);
    warn(`pack install failed (${code}): ${msg}`);
    return c.json<ErrorResponse>(
      { ok: false, code, error: msg, steps },
      code === "bad_url" ? 400 : 500
    );
  } finally {
    void rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
