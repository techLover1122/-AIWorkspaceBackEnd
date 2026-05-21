import type { Context } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { recordPort, recentPorts, recordTab, recentTabs, recentSessions } from "../utils/db.js";
import { warn } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = platform() === "win32";

export type DetectedPort = {
  port: number;
  pid: number | null;
  processName: string | null;
  appLabel: string | null;
  address: string;
  isWebUI?: boolean;
  title?: string | null;
};

const APP_HINTS: [number, string][] = [
  [3000, "Next.js / React"],
  [3001, "Express"],
  [4200, "Angular"],
  [4321, "Astro"],
  [5000, "Flask / Generic"],
  [5001, "Flask"],
  [5173, "Vite"],
  [5174, "Vite"],
  [8000, "Django / Generic"],
  [8080, "code-server / Generic"],
  [8090, "AI-IDE backend"],
  [8888, "Jupyter"],
  [9000, "PHP / Generic"],
  [11434, "Ollama"],
];

function guessAppLabel(port: number, processName: string | null): string | null {
  const hint = APP_HINTS.find(([p]) => p === port);
  if (hint) return hint[1];
  if (processName) return processName.replace(/\.exe$/i, "");
  return null;
}

/** Parse `netstat -ano` LISTENING lines on Windows. */
function parseWindowsNetstat(stdout: string): DetectedPort[] {
  const ports = new Map<number, DetectedPort>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (!m) continue;
    const address = m[1];
    const port = parseInt(m[2], 10);
    const pid = parseInt(m[3], 10);
    if (!port || port < 1) continue;
    // Prefer 127.0.0.1 / localhost entries over 0.0.0.0
    if (ports.has(port)) {
      const existing = ports.get(port)!;
      if (existing.address === "0.0.0.0" && address !== "0.0.0.0") {
        ports.set(port, { ...existing, address });
      }
      continue;
    }
    ports.set(port, { port, pid, processName: null, appLabel: null, address });
  }
  return Array.from(ports.values()).sort((a, b) => a.port - b.port);
}

/** Parse `lsof -i -P -n -sTCP:LISTEN` on Unix. */
function parseUnixLsof(stdout: string): DetectedPort[] {
  const ports = new Map<number, DetectedPort>();
  const lines = stdout.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const command = parts[0];
    const pid = parseInt(parts[1], 10);
    const node = parts[7]; // TCP/IPv4 etc.
    const nameField = parts[8] ?? "";
    if (!/LISTEN/.test(line) && !/TCP/.test(node)) continue;
    const m = nameField.match(/:(\d+)$/);
    if (!m) continue;
    const port = parseInt(m[1], 10);
    if (!port) continue;
    if (!ports.has(port)) {
      ports.set(port, {
        port,
        pid: Number.isFinite(pid) ? pid : null,
        processName: command,
        appLabel: null,
        address: nameField.split(":")[0] || "0.0.0.0",
      });
    }
  }
  return Array.from(ports.values()).sort((a, b) => a.port - b.port);
}

async function lookupProcessNamesWindows(detected: DetectedPort[]): Promise<void> {
  // One `tasklist /fo csv /nh` call, build pid -> name map
  try {
    const { stdout } = await execFileAsync("tasklist", ["/fo", "csv", "/nh"], { maxBuffer: 8 * 1024 * 1024 });
    const map = new Map<number, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) map.set(parseInt(m[2], 10), m[1]);
    }
    for (const d of detected) {
      if (d.pid && map.has(d.pid)) d.processName = map.get(d.pid)!;
    }
  } catch (err) {
    warn(`tasklist failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function scanListeningPorts(): Promise<DetectedPort[]> {
  try {
    if (IS_WINDOWS) {
      const { stdout } = await execFileAsync("netstat", ["-ano"], { maxBuffer: 8 * 1024 * 1024 });
      const detected = parseWindowsNetstat(stdout);
      await lookupProcessNamesWindows(detected);
      for (const d of detected) d.appLabel = guessAppLabel(d.port, d.processName);
      return detected;
    } else {
      const { stdout } = await execFileAsync("lsof", ["-i", "-P", "-n", "-sTCP:LISTEN"], {
        maxBuffer: 8 * 1024 * 1024,
      });
      const detected = parseUnixLsof(stdout);
      for (const d of detected) d.appLabel = guessAppLabel(d.port, d.processName);
      return detected;
    }
  } catch (err) {
    warn(`Port scan failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/* ---------- Web UI probe ---------- */

/** Probe a port to see if it speaks HTTP. Any HTTP response counts. */
async function probeWebUI(port: number, timeoutMs = 2500): Promise<{ isWebUI: boolean; title: string | null }> {
  const tryFetch = async (host: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}:${port}/`, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: { "User-Agent": "AI-IDE-Probe/1.0", Accept: "*/*" },
      });
      clearTimeout(t);
      // Any HTTP status means it's an HTTP server — that's a "web UI" for our purposes.
      // Try to pull a <title> if present.
      const ct = res.headers.get("content-type") ?? "";
      let title: string | null = null;
      if (ct.includes("text/html") || ct.includes("application/xhtml") || !ct) {
        try {
          const body = await res.text();
          const m = body.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (m) title = m[1].trim().slice(0, 80);
        } catch { /* ignore */ }
      }
      return { isWebUI: true, title };
    } catch {
      clearTimeout(t);
      return null;
    }
  };

  // Try IPv4 then IPv6 — some dev servers bind only to one.
  const r4 = await tryFetch("127.0.0.1");
  if (r4) return r4;
  const r6 = await tryFetch("[::1]");
  if (r6) return r6;
  return { isWebUI: false, title: null };
}

async function probeAll(ports: DetectedPort[]): Promise<void> {
  await Promise.all(
    ports.map(async (p) => {
      const result = await probeWebUI(p.port);
      p.isWebUI = result.isWebUI;
      p.title = result.title;
    })
  );
}

/** Scan + probe, returning only ports that serve a Web UI. Used by MCP tools. */
export async function scanWebPorts(): Promise<DetectedPort[]> {
  const detected = await scanListeningPorts();
  await probeAll(detected);
  for (const p of detected) {
    recordPort(p.port, p.processName, p.isWebUI ? (p.title || p.appLabel) : p.appLabel);
  }
  return detected.filter((p) => p.isWebUI);
}

/* ---------- Handlers ---------- */

export async function handlePortScan(c: Context) {
  const onlyWebUI = c.req.query("webui") !== "false"; // default: true
  const detected = await scanListeningPorts();
  await probeAll(detected);

  const webCount = detected.filter((p) => p.isWebUI).length;
  warn(`Port scan: ${detected.length} listening, ${webCount} HTTP-responding`);

  // Persist to DB (all detected, with appLabel)
  for (const p of detected) {
    recordPort(p.port, p.processName, p.isWebUI ? (p.title || p.appLabel) : p.appLabel);
  }

  const result = onlyWebUI ? detected.filter((p) => p.isWebUI) : detected;
  return c.json({ ports: result, totalListening: detected.length });
}

export function handleRecentPorts(c: Context) {
  return c.json({ ports: recentPorts(100) });
}

export async function handleLogTab(c: Context) {
  const body = await c.req.json() as { url: string; label: string; projectPath?: string };
  if (!body.url) return c.json({ error: "url required" }, 400);
  recordTab(body.url, body.label || body.url, body.projectPath);
  return c.json({ ok: true });
}

export function handleRecentTabs(c: Context) {
  return c.json({ tabs: recentTabs(100) });
}

export function handleRecentSessions(c: Context) {
  return c.json({ sessions: recentSessions(100) });
}
