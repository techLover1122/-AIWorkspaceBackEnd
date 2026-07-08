/**
 * Workspace backup endpoint — POST /api/backup
 *
 * Runs scripts/eba-backup.sh (project files + Postgres DB → S3, with retry,
 * local cleanup, and 24h S3 pruning) and streams each step's log line back to
 * the caller as Server-Sent Events so the "Backup" button can show live
 * progress. The script does all the real work; this handler just spawns it and
 * relays output.
 *
 * SSE events:
 *   { type: "start" }
 *   { type: "log", line: string }     — one per script output line
 *   { type: "done", ok: boolean, code: number }
 */
import type { Context } from "hono";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { info, warn } from "../utils/logger.js";

// scripts/eba-backup.sh lives at the backend repo root (../../ from src/handlers).
const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/eba-backup.sh", import.meta.url));

// Safety net — kill a runaway backup after 30 min.
const MAX_RUNTIME_MS = 30 * 60 * 1000;

export async function handleBackupRequest(c: Context) {
  const body = (await c.req.json().catch(() => ({}))) as { workingDirectory?: string };
  const projectArg =
    body.workingDirectory && existsSync(body.workingDirectory) ? body.workingDirectory : "";

  if (!existsSync(SCRIPT_PATH)) {
    warn("Backup script missing:", { SCRIPT_PATH });
    return c.json({ error: `backup script not found at ${SCRIPT_PATH}` }, 500);
  }

  info("Backup requested:", { project: projectArg || "(none — DB only)" });

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* stream already closed */
        }
      };

      const child = spawn("bash", [SCRIPT_PATH, projectArg], {
        windowsHide: true,
        env: process.env, // inherits HOME (AWS creds) + PATH (aws/docker) + docker group
      });

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 20000);

      const killTimer = setTimeout(() => {
        warn("Backup exceeded max runtime — killing", { MAX_RUNTIME_MS });
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, MAX_RUNTIME_MS);

      let finished = false;
      const finish = (ok: boolean, code: number) => {
        if (finished) return;
        finished = true;
        clearInterval(keepAlive);
        clearTimeout(killTimer);
        send({ type: "done", ok, code });
        info("Backup finished:", { ok, code });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send({ type: "start" });

      // Split combined stdout/stderr into whole lines before emitting.
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) send({ type: "log", line });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.on("error", (err) => {
        send({ type: "log", line: `spawn error: ${String(err)}` });
        finish(false, -1);
      });
      child.on("close", (code) => {
        if (buf.trim()) send({ type: "log", line: buf });
        finish(code === 0, code ?? -1);
      });

      // Client disconnected — stop the backup.
      c.req.raw.signal?.addEventListener("abort", () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        finish(false, -1);
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
