import type { Context } from "hono";
import { spawn } from "node:child_process";
import { homedir, tmpdir, platform } from "node:os";
import { join, basename } from "node:path";
import { mkdir, rm, readdir, stat, rename, writeFile, readFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import { warn, info } from "../utils/logger.js";
import { publishEvent } from "./events.js";

/**
 * Local project upload + auto-run.
 *
 * The frontend always hands us a single ZIP (a dropped .zip passed through,
 * or a folder zipped client-side with JSZip). We extract it into
 * ~/.ai-ide/projects/<name>/, then — on a separate /run call — detect the
 * project type, install deps, start the dev server, and stream output. When
 * the dev server prints a localhost URL we push an `open_tab` event so the
 * preview opens automatically.
 *
 * Why bytes-over-the-wire (not a path): the backend runs remote (EC2) while
 * the user's files are local, so a local path means nothing here.
 */

const IS_WINDOWS = platform() === "win32";
const PROJECTS_DIR = join(homedir(), ".ai-ide", "projects");
const HOME_DIR = homedir();
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

/* ───────────────────────── upload ───────────────────────── */

function safeName(raw: string): string {
  const base = basename(raw).replace(/\.zip$/i, "");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._]+/, "");
  return cleaned || "project";
}

/** Reject zip-slip entries (absolute paths or `..` traversal). */
function isUnsafeEntry(entryName: string): boolean {
  const norm = entryName.replace(/\\/g, "/");
  if (norm.startsWith("/")) return true;
  if (/^[a-zA-Z]:/.test(norm)) return true; // C:\ style
  return norm.split("/").some((seg) => seg === "..");
}

/**
 * If a staging dir contains exactly one subdir and nothing else at the top
 * level (the classic `myapp/` wrapper produced by GitHub/JSZip), return that
 * inner dir so we flatten one level. Otherwise return the staging dir.
 */
async function flattenWrapper(stagingDir: string): Promise<string> {
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const visible = entries.filter((e) => !e.name.startsWith("__MACOSX"));
  if (visible.length === 1 && visible[0].isDirectory()) {
    return join(stagingDir, visible[0].name);
  }
  return stagingDir;
}

/** Pick a non-colliding target dir under baseDir (foo, foo-2, foo-3…). */
async function uniqueProjectDir(baseDir: string, name: string): Promise<string> {
  let candidate = join(baseDir, name);
  let n = 2;
  for (;;) {
    try {
      await access(candidate);
      candidate = join(baseDir, `${name}-${n}`);
      n += 1;
    } catch {
      return candidate;
    }
  }
}

/**
 * POST /api/projects/upload?name=<name>
 * Body: raw zip bytes (application/zip).
 * Returns { ok, projectPath, name }.
 */
export async function handleProjectUpload(c: Context): Promise<Response> {
  const rawName = c.req.query("name") ?? c.req.header("x-project-name") ?? "project";
  const name = safeName(rawName);

  // workingDirectory is the currently open folder in the IDE; we extract the
  // project into a new subfolder there so the user's root doesn't change.
  // Falls back to the managed ~/.ai-ide/projects/ dir if not provided.
  const rawWd = c.req.query("workingDirectory");
  const targetBaseDir =
    rawWd && rawWd.trim()
      ? rawWd.trim()
      : PROJECTS_DIR;

  let buf: Buffer;
  try {
    const ab = await c.req.arrayBuffer();
    buf = Buffer.from(ab);
  } catch {
    return c.json({ ok: false, code: "bad_request", error: "Could not read upload body" }, 400);
  }

  if (buf.byteLength === 0) {
    return c.json({ ok: false, code: "bad_request", error: "Empty upload" }, 400);
  }
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    return c.json(
      { ok: false, code: "too_large", error: `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` },
      413
    );
  }

  const tempRoot = join(tmpdir(), `aiide-proj-${randomBytes(6).toString("hex")}`);
  const stagingDir = join(tempRoot, "staging");

  try {
    await mkdir(stagingDir, { recursive: true });

    // Validate + extract.
    let zip: AdmZip;
    try {
      zip = new AdmZip(buf);
    } catch {
      return c.json({ ok: false, code: "bad_zip", error: "Not a valid zip archive" }, 400);
    }
    for (const entry of zip.getEntries()) {
      if (isUnsafeEntry(entry.entryName)) {
        return c.json(
          { ok: false, code: "unsafe_zip", error: `Refusing unsafe path: ${entry.entryName}` },
          400
        );
      }
    }
    zip.extractAllTo(stagingDir, /* overwrite */ true);

    const root = await flattenWrapper(stagingDir);

    await mkdir(targetBaseDir, { recursive: true });
    const projectPath = await uniqueProjectDir(targetBaseDir, name);
    // rename is atomic on same fs; staging lives under tmpdir which may be a
    // different volume, so fall back to a recursive copy on EXDEV.
    try {
      await rename(root, projectPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        const { cp } = await import("node:fs/promises");
        await cp(root, projectPath, { recursive: true });
      } else {
        throw err;
      }
    }

    // Clean up the original zip if it lives in the same directory (e.g. the
    // user had myapp.zip in their workspace before uploading it).
    const zipArtifact = join(targetBaseDir, `${name}.zip`);
    await rm(zipArtifact, { force: true }).catch(() => {});

    info(`[project-upload] extracted "${name}" → ${projectPath}`);
    return c.json({ ok: true, projectPath, name: basename(projectPath) });
  } catch (err) {
    warn("[project-upload] failed:", err);
    return c.json(
      { ok: false, code: "extract_failed", error: (err as Error).message },
      500
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/* ───────────────────────── run ───────────────────────── */

type RunPhase = "detected" | "installing" | "starting" | "log" | "port" | "error" | "exit";
type RunEvent = { phase: RunPhase; data?: string; port?: number; url?: string; code?: number | null };
type RunSubscriber = (e: RunEvent) => void;

type RunSession = {
  id: string;
  projectPath: string;
  buffer: RunEvent[]; // ring buffer of recent events for late subscribers
  subscribers: Set<RunSubscriber>;
  portOpened: boolean;
  done: boolean;
  procs: { kill: () => void }[];
};

const RUNS = new Map<string, RunSession>();
const BUFFER_CAP = 500;

function emit(session: RunSession, e: RunEvent): void {
  session.buffer.push(e);
  if (session.buffer.length > BUFFER_CAP) session.buffer.shift();
  for (const sub of session.subscribers) {
    try {
      sub(e);
    } catch {
      /* ignore */
    }
  }
}

const PORT_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):(\d{2,5})/i;

function maybeOpenPreview(session: RunSession, text: string, label: string): void {
  if (session.portOpened) return;
  const m = text.match(PORT_RE);
  if (!m) return;
  const port = parseInt(m[1], 10);
  if (!port || port < 1 || port > 65535) return;
  session.portOpened = true;
  const url = `http://localhost:${port}`;
  emit(session, { phase: "port", port, url });
  publishEvent({ type: "open_tab", url, label: `${label} (preview)` });
  info(`[project-run] ${session.id} preview → ${url}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

type Plan = { label: string; install?: string; start: string } | { label: string; unsupported: string };

/** Detect how to install + start a project from the files on disk. */
async function detectPlan(dir: string): Promise<Plan> {
  // Node / JS
  if (await pathExists(join(dir, "package.json"))) {
    let pkg: { scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    } catch {
      /* malformed — treat as no scripts */
    }
    const scripts = pkg.scripts ?? {};
    let pm = "npm";
    if (await pathExists(join(dir, "pnpm-lock.yaml"))) pm = "pnpm";
    else if (await pathExists(join(dir, "yarn.lock"))) pm = "yarn";
    else if (await pathExists(join(dir, "bun.lockb"))) pm = "bun";

    const install =
      pm === "npm" ? "npm install" : pm === "yarn" ? "yarn install" : `${pm} install`;
    const scriptName = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : null;
    if (!scriptName) {
      return { label: "node", unsupported: "package.json has no dev/start/serve script" };
    }
    const runScript =
      pm === "npm" ? `npm run ${scriptName}` : `${pm} run ${scriptName}`;
    return { label: "node", install, start: runScript };
  }

  // Python
  const hasReq = await pathExists(join(dir, "requirements.txt"));
  const hasPyproject = await pathExists(join(dir, "pyproject.toml"));
  if (hasReq || hasPyproject) {
    const py = IS_WINDOWS ? "python" : "python3";
    const install = hasReq ? `${py} -m pip install -r requirements.txt` : undefined;
    let start: string;
    if (await pathExists(join(dir, "manage.py"))) start = `${py} manage.py runserver 0.0.0.0:8000`;
    else if (await pathExists(join(dir, "app.py"))) start = `${py} app.py`;
    else if (await pathExists(join(dir, "main.py"))) start = `${py} main.py`;
    else return { label: "python", unsupported: "no manage.py / app.py / main.py to run" };
    return { label: "python", install, start };
  }

  // Go
  if (await pathExists(join(dir, "go.mod"))) {
    return { label: "go", start: "go run ." };
  }

  // Rust
  if (await pathExists(join(dir, "Cargo.toml"))) {
    return { label: "rust", start: "cargo run" };
  }

  // Static site
  if (await pathExists(join(dir, "index.html"))) {
    return { label: "static", start: "npx --yes serve -l 4173 ." };
  }

  return { label: "unknown", unsupported: "could not detect project type" };
}

function runCommand(
  session: RunSession,
  cmd: string,
  cwd: string,
  label: string
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0", CI: "1", BROWSER: "none" },
    });
    session.procs.push({ kill: () => child.kill() });

    const onChunk = (b: Buffer) => {
      const text = b.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        emit(session, { phase: "log", data: line });
      }
      maybeOpenPreview(session, text, label);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      emit(session, { phase: "error", data: err.message });
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
}

async function executePlan(session: RunSession, plan: Plan, label: string): Promise<void> {
  try {
    if ("unsupported" in plan) {
      emit(session, { phase: "error", data: `Cannot auto-run: ${plan.unsupported}` });
      emit(session, { phase: "exit", code: 1 });
      session.done = true;
      return;
    }

    emit(session, { phase: "detected", data: plan.label });

    if (plan.install) {
      emit(session, { phase: "installing", data: plan.install });
      const code = await runCommand(session, plan.install, session.projectPath, label);
      if (code !== 0) {
        emit(session, { phase: "error", data: `Install failed (exit ${code})` });
        emit(session, { phase: "exit", code });
        session.done = true;
        return;
      }
    }

    emit(session, { phase: "starting", data: plan.start });
    const code = await runCommand(session, plan.start, session.projectPath, label);
    emit(session, { phase: "exit", code });
    session.done = true;
  } catch (err) {
    emit(session, { phase: "error", data: (err as Error).message });
    emit(session, { phase: "exit", code: 1 });
    session.done = true;
  }
}

/**
 * POST /api/projects/run
 * Body: { projectPath }
 * Returns { ok, runId } immediately; work proceeds in the background and is
 * observable via GET /api/projects/run/:runId/stream.
 */
export async function handleProjectRun(c: Context): Promise<Response> {
  let body: { projectPath?: unknown };
  try {
    body = (await c.req.json()) as { projectPath?: unknown };
  } catch {
    return c.json({ ok: false, code: "bad_request", error: "Invalid JSON body" }, 400);
  }
  const projectPath = typeof body.projectPath === "string" ? body.projectPath : "";
  if (!projectPath) {
    return c.json({ ok: false, code: "bad_request", error: "Missing projectPath" }, 400);
  }

  // Only allow running projects inside the user's home directory — prevents
  // this endpoint from being used as a "run any path on the box" primitive.
  if (!projectPath.startsWith(HOME_DIR)) {
    return c.json(
      { ok: false, code: "forbidden", error: "projectPath must be within the home directory" },
      403
    );
  }
  try {
    const s = await stat(projectPath);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    return c.json({ ok: false, code: "not_found", error: "projectPath does not exist" }, 404);
  }

  const runId = randomBytes(8).toString("hex");
  const label = basename(projectPath);
  const session: RunSession = {
    id: runId,
    projectPath,
    buffer: [],
    subscribers: new Set(),
    portOpened: false,
    done: false,
    procs: [],
  };
  RUNS.set(runId, session);

  // Kick off detection + run in the background.
  void (async () => {
    const plan = await detectPlan(projectPath);
    await executePlan(session, plan, label);
    // Keep the session around briefly so late subscribers see the tail, then GC.
    setTimeout(() => RUNS.delete(runId), 5 * 60 * 1000);
  })();

  return c.json({ ok: true, runId });
}

/**
 * GET /api/projects/run/:runId/stream — SSE of run lifecycle + log lines.
 * Replays the buffered events first so a late subscriber catches up.
 */
export function handleProjectRunStream(c: Context): Response {
  const runId = c.req.param("runId") ?? "";
  const session = RUNS.get(runId);

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const write = (e: RunEvent | { phase: string }) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* closed */
        }
      };

      if (!session) {
        write({ phase: "error", data: "Unknown runId" } as RunEvent);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      // Replay buffered history.
      for (const e of session.buffer) write(e);

      if (session.done) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 25000);

      const sub: RunSubscriber = (e) => {
        write(e);
        if (e.phase === "exit") {
          clearInterval(keepAlive);
          session.subscribers.delete(sub);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      session.subscribers.add(sub);

      c.req.raw.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive);
        session.subscribers.delete(sub);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return c.newResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
