import type { Context } from "hono";
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { warn } from "../utils/logger.js";
import { PLUGIN_GUID } from "./plugin.js";
import { buildEmptyOffice } from "./office-templates.js";

/**
 * Office editor bridge — talks to the two pre-installed ONLYOFFICE Docs
 * Server containers (docs:4000 / sheets:4001) that cloud-init.sh sets up.
 *
 * Three responsibilities, all keyed off a `fileId` the frontend chooses:
 *
 *   POST /api/office/config
 *     Returns a signed editor config (JWT'd per ONLYOFFICE rules) that
 *     the frontend hands to `new DocsAPI.DocEditor("placeholder", cfg)`.
 *
 *   POST /api/office/callback
 *     ONLYOFFICE's save-loop endpoint. status=2 (saved) downloads the
 *     temp file ONLYOFFICE hosts and overwrites our copy; status=6
 *     (forcesave) does the same without bumping the version.
 *
 *   GET /api/office/file/:fileId
 *     The URL ONLYOFFICE itself fetches the document from. Authenticated
 *     by the Authorization JWT ONLYOFFICE attaches to outbound requests.
 *
 *   GET /api/office/editor?fileId=&type=&name=
 *     A self-contained HTML page that mounts the ONLYOFFICE editor. It
 *     fetches its own /api/office/config (same-origin), loads the Docs
 *     Server api.js, and calls `new DocsAPI.DocEditor(...)`. This is what
 *     the headless co-editor Playwright sessions open, and what replaces
 *     the legacy `employee-todo` Next.js app that used to host the iframe.
 *
 * Plus a minimal upload route so seed files can land in workspace
 * storage before the first open:
 *
 *   PUT /api/office/file/:fileId        (raw body = file bytes)
 *
 * Storage is plain disk under $HOME/.ai-ide/office/<fileId>/current.<ext>,
 * with a sibling state.json holding the per-file metadata (current
 * document key, version, type). The "live editing session is the source
 * of truth, not the file on disk" invariant means: every save here must
 * bump `key` so ONLYOFFICE doesn't serve a stale cached copy on reopen.
 */

const OFFICE_DIR =
  process.env.OFFICE_STORAGE_DIR ??
  path.join(homedir(), ".ai-ide", "office");

const STATE_FILE = path.join(OFFICE_DIR, "state.json");

function jwtSecretBytes(): Uint8Array {
  const s = process.env.OFFICE_JWT_SECRET;
  if (!s) {
    throw new Error(
      "OFFICE_JWT_SECRET is not set — refusing to sign/verify office tokens"
    );
  }
  return new TextEncoder().encode(s);
}

type FileType = "docx" | "xlsx";

interface FileState {
  fileId: string;
  fileName: string;
  fileType: FileType;
  /** Unique per content version. Bumped on status=2 saves. */
  key: string;
  version: number;
  updatedAt: string;
}

interface StateFile {
  files: Record<string, FileState>;
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(OFFICE_DIR, { recursive: true });
}

async function loadState(): Promise<StateFile> {
  await ensureDir();
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as StateFile;
  } catch {
    return { files: {} };
  }
}

async function saveState(s: StateFile): Promise<void> {
  await ensureDir();
  await fsp.writeFile(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

function randomKey(): string {
  // 16 hex chars is plenty — ONLYOFFICE just needs uniqueness per content
  // version, not crypto-grade entropy. Prefix with a timestamp for
  // debugging convenience.
  return `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function detectFileType(name: string, override?: FileType): FileType {
  if (override === "docx" || override === "xlsx") return override;
  return path.extname(name).toLowerCase() === ".xlsx" ? "xlsx" : "docx";
}

/**
 * Base URL the user's browser uses to reach this backend — derived from
 * /etc/workspace.env (USER_ID + PLATFORM_DOMAIN + PLATFORM_PROTOCOL).
 * Also doubles as the URL the ONLYOFFICE container uses for the file-
 * fetch + callback endpoints (the container can resolve and reach the
 * public host through Traefik just fine).
 */
function publicApiBase(): string {
  const scheme = process.env.PLATFORM_PROTOCOL ?? "http";
  const userId = process.env.USER_ID;
  const domain = process.env.PLATFORM_DOMAIN;
  if (!userId || !domain) {
    const port = process.env.PORT ?? "8090";
    return `http://localhost:${port}`;
  }
  return `${scheme}://api-${userId}.${domain}`;
}

/** Public URL of the ONLYOFFICE Docs Server hosting a given file type. */
function officeScriptUrl(type: FileType): string {
  const scheme = process.env.PLATFORM_PROTOCOL ?? "http";
  const userId = process.env.USER_ID;
  const domain = process.env.PLATFORM_DOMAIN;
  const svc = type === "xlsx" ? "sheets" : "docs";
  if (!userId || !domain) {
    return `http://localhost:${type === "xlsx" ? 4001 : 4000}/web-apps/apps/api/documents/api.js`;
  }
  return `${scheme}://${svc}-${userId}.${domain}/web-apps/apps/api/documents/api.js`;
}

async function signObject(obj: JWTPayload): Promise<string> {
  return new SignJWT(obj)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(jwtSecretBytes());
}

async function verifyToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwtSecretBytes());
  return payload;
}

function filePath(fs: FileState): string {
  return path.join(OFFICE_DIR, fs.fileId, `current.${fs.fileType}`);
}

/* ───────────────────────── handlers ───────────────────────── */

/**
 * POST /api/office/config
 * Body: { fileId, fileName?, fileType?, userName? }
 *
 * Creates a row in state.json if the fileId is new, then returns the
 * editor config (with `token` JWT) + the script URL the frontend must
 * load to get `DocsAPI` on the page. fileType is detected from the
 * fileName extension if not provided.
 */
export async function handleEditorConfig(c: Context) {
  let body: {
    fileId?: string;
    fileName?: string;
    fileType?: FileType;
    userName?: string;
  } | null;
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  if (!body?.fileId) return c.json({ error: "fileId is required" }, 400);

  const fileType = detectFileType(body.fileName ?? "", body.fileType);
  const fileName = body.fileName ?? `${body.fileId}.${fileType}`;

  const state = await loadState();
  let fs = state.files[body.fileId];
  if (!fs) {
    fs = {
      fileId: body.fileId,
      fileName,
      fileType,
      key: randomKey(),
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    state.files[body.fileId] = fs;
    // Empty-file bootstrap: ONLYOFFICE needs valid OOXML bytes at
    // document.url on first open. Generate the minimum-valid empty
    // DOCX/XLSX via office-templates.ts and write it before responding,
    // so the first /api/office/file/:id fetch from the container
    // doesn't 404. saveState comes AFTER the file write — if the file
    // write fails, we don't want a state.json entry pointing at a
    // missing file on disk.
    const target = filePath(fs);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buildEmptyOffice(fs.fileType));
    await saveState(state);
  }

  const base = publicApiBase();
  const documentType: "word" | "cell" = fs.fileType === "xlsx" ? "cell" : "word";

  // ONLYOFFICE expects the inner config to also be signed in the
  // top-level `token` field. The keys here mirror the v7+ schema.
  //
  // The `plugins` block autostarts the ai-agent-bridge plugin on every
  // open so the docs-agent / sheets-agent sidecars can issue commands
  // into the editor's JS API over WebSocket. pluginsData URL points at
  // OUR backend (api-<userId>); the plugin then loads the ONLYOFFICE
  // SDK from the parent editor's origin — see handlers/plugin.ts.
  const inner = {
    document: {
      fileType: fs.fileType,
      key: fs.key,
      title: fs.fileName,
      url: `${base}/api/office/file/${encodeURIComponent(fs.fileId)}`,
    },
    documentType,
    editorConfig: {
      mode: "edit",
      callbackUrl: `${base}/api/office/callback?fileId=${encodeURIComponent(fs.fileId)}`,
      user: {
        id: process.env.USER_ID ?? "anonymous",
        name: body.userName ?? "User",
      },
      plugins: {
        autostart: [PLUGIN_GUID],
        pluginsData: [`${base}/api/plugin/ai-agent-bridge/config.json`],
      },
    },
  };
  const token = await signObject(inner as unknown as JWTPayload);

  return c.json({
    config: { ...inner, token },
    scriptUrl: officeScriptUrl(fs.fileType),
  });
}

/**
 * POST /api/office/callback?fileId=<id>
 *
 * ONLYOFFICE save-loop. Body is JSON containing `status` (2=ready to
 * save, 3=save error, 4=closed-no-changes, 6=forcesave, 7=forcesave
 * error) plus, on save statuses, a `url` to download the updated file
 * from. With JWT_ENABLED=true the body's `token` field is the JWT'd
 * payload — we verify it against OFFICE_JWT_SECRET.
 *
 * Must always reply 200 with { "error": 0 } on success — any other
 * shape and ONLYOFFICE shows the user an error toast.
 */
export async function handleCallback(c: Context) {
  const fileId = c.req.query("fileId");
  if (!fileId) return c.json({ error: 1, message: "fileId required" });

  let body: {
    status?: number;
    url?: string;
    token?: string;
    users?: string[];
    key?: string;
  } | null;
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 1, message: "invalid body" });
  }
  if (!body) return c.json({ error: 1, message: "invalid body" });

  if (body.token) {
    try {
      await verifyToken(body.token);
    } catch (err) {
      warn(
        `office callback: JWT verification failed for ${fileId}: ${
          err instanceof Error ? err.message : err
        }`
      );
      return c.json({ error: 1, message: "invalid token" });
    }
  }

  const status = body.status ?? 0;

  // Save / forcesave: download from ONLYOFFICE's temp URL, overwrite.
  if ((status === 2 || status === 6) && body.url) {
    try {
      const state = await loadState();
      const fs = state.files[fileId];
      if (!fs) {
        warn(`office callback: unknown fileId ${fileId}`);
        return c.json({ error: 1, message: "unknown fileId" });
      }

      const res = await fetch(body.url);
      if (!res.ok) {
        warn(
          `office callback: failed to download ${body.url}: ${res.status}`
        );
        return c.json({ error: 1, message: "download failed" });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const target = filePath(fs);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, buf);

      // status=2 → user closed; bump key so the next open isn't served
      // from ONLYOFFICE's content cache. status=6 → forcesave during
      // an active session; keep the key so the live session continues.
      if (status === 2) {
        fs.key = randomKey();
        fs.version += 1;
      }
      fs.updatedAt = new Date().toISOString();
      await saveState(state);
    } catch (err) {
      warn(
        `office callback save failed for ${fileId}: ${
          err instanceof Error ? err.message : err
        }`
      );
      return c.json({ error: 1 });
    }
  }

  return c.json({ error: 0 });
}

/**
 * GET /api/office/file/:fileId
 *
 * ONLYOFFICE downloads the document from here. When JWT_ENABLED=true the
 * container attaches an `Authorization: Bearer <JWT>` header on outbound
 * fetches, signed with OFFICE_JWT_SECRET — we validate that signature
 * (claim shape varies by version, so we don't pin specific claims).
 */
export async function handleFileFetch(c: Context) {
  const fileId = c.req.param("fileId");
  if (!fileId) return c.text("missing fileId", 400);

  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return c.text("missing bearer token", 401);
  }
  const token = auth.slice("bearer ".length).trim();
  try {
    await verifyToken(token);
  } catch (err) {
    warn(
      `office file fetch: JWT verification failed for ${fileId}: ${
        err instanceof Error ? err.message : err
      }`
    );
    return c.text("invalid token", 401);
  }

  const state = await loadState();
  const fs = state.files[fileId];
  if (!fs) return c.text("not found", 404);

  const target = filePath(fs);
  if (!existsSync(target)) {
    return c.text("file not yet uploaded — PUT bytes first", 404);
  }
  const data = await fsp.readFile(target);
  const mime =
    fs.fileType === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  c.header("Content-Type", mime);
  c.header("Content-Length", String(data.length));
  return c.body(new Uint8Array(data));
}

/**
 * PUT /api/office/file/:fileId
 * Raw body = file bytes. Query: ?fileName=foo.docx (optional).
 *
 * Minimal upload endpoint so the frontend (or a curl seed) can put a
 * document into storage before the first editor open. Doesn't need a
 * live session — bumps the key so the next config request reflects the
 * new content.
 */
export async function handleFileUpload(c: Context) {
  const fileId = c.req.param("fileId");
  if (!fileId) return c.json({ error: "missing fileId" }, 400);

  const queryName = c.req.query("fileName");
  const fileType = detectFileType(queryName ?? "");

  const ab = await c.req.arrayBuffer();
  if (!ab.byteLength) return c.json({ error: "empty body" }, 400);

  const state = await loadState();
  const existing = state.files[fileId];
  const fs: FileState = existing ?? {
    fileId,
    fileName: queryName ?? `${fileId}.${fileType}`,
    fileType,
    key: randomKey(),
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    // Replacing existing content — bump key so live sessions get a
    // fresh copy on next open.
    fs.key = randomKey();
    fs.version += 1;
    if (queryName) fs.fileName = queryName;
    fs.fileType = detectFileType(fs.fileName);
  }

  const target = filePath(fs);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.from(ab));

  state.files[fileId] = fs;
  await saveState(state);

  return c.json({
    fileId: fs.fileId,
    fileName: fs.fileName,
    fileType: fs.fileType,
    version: fs.version,
    key: fs.key,
  });
}

/**
 * GET /api/office/editor?fileId=<id>&type=<docx|xlsx>&name=<title>
 *
 * Returns a self-contained HTML page that mounts the ONLYOFFICE editor.
 * The page POSTs to /api/office/config (same-origin) to obtain the signed
 * config + the Docs Server api.js URL, loads that script, then calls
 * `new DocsAPI.DocEditor("editor", config)`.
 *
 * This replaces the legacy `employee-todo` Next.js app (port 3456 /
 * employees-<USER>.<DOMAIN>/edit) that never existed on the instance.
 * The headless co-editor Playwright sessions (headless-coeditors.sh) open
 * this URL so the ai-agent-bridge plugin can connect docs-agent /
 * sheets-agent even with no user tab open. Since the editor still loads
 * from docs-<USER> / sheets-<USER>, the plugin derives the correct agent
 * WebSocket origin from the editor frame, not from this page.
 *
 * All params are read client-side from the query string, so there's no
 * server-side interpolation of untrusted input into the HTML.
 */
export async function handleEditorPage(c: Context) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Office Editor</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; }
    #editor { position: absolute; inset: 0; }
    #err { font: 14px/1.5 system-ui, sans-serif; padding: 16px; color: #b00; }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>
    (async function () {
      try {
        var qs = new URLSearchParams(location.search);
        var fileId = qs.get("fileId") || "default-doc";
        var fileType = qs.get("type") || "docx";
        var fileName = qs.get("name") || (fileId + "." + fileType);

        var res = await fetch("/api/office/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: fileId, fileType: fileType, fileName: fileName })
        });
        if (!res.ok) throw new Error("config request failed: " + res.status);
        var data = await res.json();
        if (!data || !data.config || !data.scriptUrl) {
          throw new Error("config response missing config/scriptUrl");
        }

        await new Promise(function (resolve, reject) {
          var s = document.createElement("script");
          s.src = data.scriptUrl;
          s.onload = resolve;
          s.onerror = function () { reject(new Error("failed to load " + data.scriptUrl)); };
          document.head.appendChild(s);
        });

        // eslint-disable-next-line no-new, no-undef
        new DocsAPI.DocEditor("editor", data.config);
      } catch (e) {
        document.body.innerHTML =
          '<pre id="err">Editor failed to load:\\n' +
          String((e && e.message) || e) + "</pre>";
      }
    })();
  </script>
</body>
</html>`;
  return c.html(html);
}
