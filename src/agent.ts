/**
 * docs-agent / sheets-agent sidecar.
 *
 * Single binary, two instances per workspace — discriminated by env:
 *
 *   AGENT_KIND=docs    PORT=4100  → owns the "word"  editor type
 *   AGENT_KIND=sheets  PORT=4101  → owns the "cell"  editor type
 *
 * Two ingress paths:
 *
 *   WS  /plugin   ← the ai-agent-bridge plugin running inside the
 *                  user's ONLYOFFICE editor iframe connects here on
 *                  load and stays open. We track every live connection
 *                  by editorType.
 *
 *   POST /cmd     ← the backend's MCP tools (handlers/aiideTools.ts in
 *                  Phase 6) call this with { op, args }. We forward the
 *                  command over the first matching plugin WS, await its
 *                  reply, and return it.
 *
 *   GET  /health  ← liveness + a peek at how many editors are connected.
 *
 * Phase 5 v1 ships only "ride the user's open editor session" mode —
 * commands fire at the human's current editor. The follow-up is a
 * separate-identity Playwright headless co-editor (drove via `docker
 * exec ai-ide-playwright`) so the agent works even with the user tab
 * closed. The handler split here is deliberately mode-agnostic — once
 * the headless session connects to the same /plugin endpoint, the
 * dispatcher picks whichever plugin connected first. See pickConn().
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

const KIND = (process.env.AGENT_KIND ?? "docs").toLowerCase() === "sheets"
  ? "sheets"
  : "docs";
const PORT = Number(process.env.PORT ?? (KIND === "sheets" ? 4101 : 4100));
const HOST = process.env.HOST ?? "0.0.0.0";

// "word" for docs, "cell" for sheets — the editorType value the
// ai-agent-bridge plugin reports in its hello message.
const EDITOR_TYPE: "word" | "cell" = KIND === "sheets" ? "cell" : "word";

// How long to wait for a plugin to reply after we forward a command.
// 15s covers most Asc.plugin.callCommand operations even when the
// editor is mid-recalc; longer than that and the editor is wedged.
const CMD_TIMEOUT_MS = 15_000;

interface Conn {
  id: number;
  ws: WebSocket;
  editorType: string | null;
  helloAt: number;
}
const conns = new Map<number, Conn>();
let nextConnId = 1;

interface Pending {
  resolve: (r: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<number, Pending>();
let nextReqId = 1;

function logLine(msg: string) {
  console.log(`[${KIND}-agent] ${msg}`);
}

/**
 * Pick a connected plugin for this agent's editor type. First-match
 * wins — once we have a headless co-editor session it'll register
 * alongside the human's session and we'll prefer it via insertion
 * order (Map iteration order is insertion order).
 */
function pickConn(): Conn | null {
  for (const c of conns.values()) {
    if (c.editorType === EDITOR_TYPE) return c;
  }
  return null;
}

function forwardCmd(op: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = pickConn();
    if (!conn) {
      reject(
        new Error(
          `no ${KIND} editor session connected — open the document in the workspace first`
        )
      );
      return;
    }
    const id = nextReqId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`cmd "${op}" timed out after ${CMD_TIMEOUT_MS}ms`));
      }
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      conn.ws.send(JSON.stringify({ id, op, args: args ?? {} }));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/* ─────────────────────────── HTTP ─────────────────────────── */

// Reflect the Origin header with credentials — mirrors the existing
// backend's CORS posture (see app.ts) so a request from any of the
// platform's per-user subdomains works without per-domain config.
function setCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin ?? "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function jsonResponse(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown
) {
  setCors(req, res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1 << 20) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return jsonResponse(req, res, 200, {
      status: "ok",
      kind: KIND,
      editorType: EDITOR_TYPE,
      port: PORT,
      connections: conns.size,
      pending: pending.size,
    });
  }

  if (req.method === "POST" && url.pathname === "/cmd") {
    try {
      const body = (await readJsonBody(req)) as {
        op?: string;
        args?: unknown;
      };
      if (!body.op || typeof body.op !== "string") {
        return jsonResponse(req, res, 400, { error: "op (string) required" });
      }
      const result = await forwardCmd(body.op, body.args);
      return jsonResponse(req, res, 200, { ok: true, result });
    } catch (err) {
      return jsonResponse(req, res, 502, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return jsonResponse(req, res, 404, { error: "not found" });
});

/* ─────────────────────────── WS ─────────────────────────── */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/plugin") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    onPluginConnected(ws);
  });
});

function onPluginConnected(ws: WebSocket) {
  const id = nextConnId++;
  const conn: Conn = { id, ws, editorType: null, helloAt: 0 };
  conns.set(id, conn);
  logLine(`plugin connected (conn id=${id}, total=${conns.size})`);

  ws.on("message", (data) => {
    let msg: {
      type?: string;
      editorType?: string;
      id?: number;
      result?: unknown;
    };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg.type === "hello") {
      conn.editorType =
        typeof msg.editorType === "string" ? msg.editorType : null;
      conn.helloAt = Date.now();
      logLine(`hello from conn id=${id} editorType=${conn.editorType}`);
      // Drop the connection if it's the wrong editor type for this
      // agent — the plugin is shared across docs/sheets, so a sheets
      // plugin might briefly connect here if DNS routes it wrong.
      // Closing fast keeps pickConn() clean.
      if (conn.editorType && conn.editorType !== EDITOR_TYPE) {
        logLine(
          `dropping conn id=${id} — editorType=${conn.editorType} doesn't match this agent (${EDITOR_TYPE})`
        );
        try {
          ws.close(1008, "wrong editor type");
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // Plugin response to a command we forwarded.
    if (typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.result);
      }
    }
  });

  ws.on("close", () => {
    conns.delete(id);
    logLine(`plugin disconnected (conn id=${id}, total=${conns.size})`);
  });
  ws.on("error", (err) => {
    logLine(`ws error on conn id=${id}: ${err.message}`);
  });
}

server.listen(PORT, HOST, () => {
  logLine(`listening on http://${HOST}:${PORT} (WS at /plugin)`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logLine(`${sig} — shutting down`);
    server.close(() => process.exit(0));
  });
}
