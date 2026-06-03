import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { info, error as logError } from "../utils/logger.js";

/**
 * Terminal sessions are PTY-backed shells exposed over WebSocket. Each
 * connection spawns one node-pty instance and bridges its stdio to the
 * frontend xterm.js component.
 *
 * Protocol (JSON messages both directions):
 *   client → server: { type: "data", data: string }
 *   client → server: { type: "resize", cols: number, rows: number }
 *   server → client: { type: "data", data: string }
 *   server → client: { type: "exit", code: number | null }
 *   server → client: { type: "error", data: string }
 *
 * node-pty is loaded dynamically because it's a native binding — on
 * dev boxes without build tools it can fail to load, and we want the
 * rest of the backend to keep working in that case. The terminal route
 * sends a clean error to the client instead of crashing the whole
 * server.
 */

type PtyModule = typeof import("node-pty");
type IPty = import("node-pty").IPty;

let ptyModulePromise: Promise<PtyModule | null> | null = null;
function loadPty(): Promise<PtyModule | null> {
  if (!ptyModulePromise) {
    ptyModulePromise = import("node-pty").catch((err) => {
      logError("Failed to load node-pty native binding:", err);
      return null;
    });
  }
  return ptyModulePromise;
}

const wss = new WebSocketServer({ noServer: true });

function pickShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    // PowerShell ships with Windows; preferred over cmd for color support.
    return { command: "powershell.exe", args: [] };
  }
  const shell = process.env.SHELL ?? "/bin/bash";
  // Login-ish shell so PATH / aliases from the user's profile are loaded.
  // Falls back gracefully if the shell ignores the flag.
  return { command: shell, args: ["-l"] };
}

async function handleConnection(
  ws: WebSocket,
  _req: IncomingMessage
): Promise<void> {
  const ptyMod = await loadPty();
  if (!ptyMod) {
    safeSend(ws, {
      type: "error",
      data:
        "Terminal native binding (node-pty) is not available in this " +
        "environment. Try `npm rebuild node-pty` on the backend.\r\n",
    });
    safeClose(ws);
    return;
  }

  const { command, args } = pickShell();
  let pty: IPty;
  try {
    pty = ptyMod.spawn(command, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.env.HOME ?? process.cwd(),
      env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
    });
  } catch (err) {
    logError("Failed to spawn PTY shell:", err);
    safeSend(ws, {
      type: "error",
      data: `Failed to start ${command}: ${(err as Error).message}\r\n`,
    });
    safeClose(ws);
    return;
  }

  info(`[terminal] PTY ${pty.pid} spawned (${command})`);

  pty.onData((data) => {
    safeSend(ws, { type: "data", data });
  });

  pty.onExit(({ exitCode }) => {
    safeSend(ws, { type: "exit", code: exitCode });
    safeClose(ws);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.type === "data" && typeof msg.data === "string") {
        pty.write(msg.data);
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number" &&
        msg.cols > 0 &&
        msg.rows > 0
      ) {
        pty.resize(msg.cols, msg.rows);
      }
    } catch {
      // Malformed frame — ignore. The shell can't help with that.
    }
  });

  // Heartbeat: most edge proxies (Traefik default, nginx default,
  // Cloudflare 100s) drop idle WebSockets after ~60s, which is what
  // surfaced as the random "[connection closed]" mid-session bug.
  // A 25s server ping keeps the upstream alive without spamming.
  // The browser auto-responds to ping with pong — no client wiring
  // needed beyond reading the frame.
  const pingInterval: NodeJS.Timeout = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.ping();
    } catch {
      // socket lost — the close handler will run shortly
    }
  }, 25_000);

  const cleanup = (): void => {
    clearInterval(pingInterval);
    try {
      pty.kill();
    } catch {
      // already dead
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // socket lost between check and send — fine
  }
}

function safeClose(ws: WebSocket): void {
  try {
    ws.close();
  } catch {
    // already closed
  }
}

/**
 * Wire the terminal WebSocket route onto the existing Node HTTP server
 * returned by Hono's serve(). Call once after the server starts.
 */
export function attachTerminalWebSocket(
  server: HttpServer,
  path = "/api/terminal"
): void {
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ws, req);
    });
  });
  info(`[terminal] WebSocket route mounted at ${path}`);
}
