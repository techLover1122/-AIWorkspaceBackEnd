import { Context } from "hono";
import type { StreamResponse } from "../types.js";
import { info, warn } from "../utils/logger.js";
import {
  getTask,
  subscribeToTask,
  listActiveTasks,
  type BufferedEvent,
} from "../utils/taskRegistry.js";
import { isPending } from "./permission.js";

/**
 * GET /api/chat/stream/:taskId?from=<seq>
 *
 * Open an NDJSON stream that replays buffered events from `from` (default
 * 0) and then live-tails any new events until the task completes. Each
 * non-heartbeat line is a BufferedEvent shape: `{ seq, event }`.
 * Heartbeats arrive as bare `{ type: "heartbeat" }` lines without a seq —
 * clients branch on payload shape.
 *
 * Clients can disconnect and reconnect freely — the task lives in the
 * registry independent of any one stream. Pass `from=<lastSeenSeq+1>` on
 * reconnect to resume without losing or duplicating events.
 */
export async function handleChatStreamRequest(c: Context) {
  const taskId = c.req.param("taskId");
  if (!taskId) return c.json({ error: "Missing taskId" }, 400);

  const fromParam = c.req.query("from");
  const fromSeq = fromParam ? Math.max(0, parseInt(fromParam, 10) || 0) : 0;

  const task = getTask(taskId);
  if (!task) {
    return c.json({ error: "Unknown task — it may have expired" }, 404);
  }

  info("Chat stream attach:", {
    taskId,
    fromSeq,
    status: task.status,
    bufferSize: task.events.length,
    subscribers: task.subscribers.size,
  });

  const stream = new ReadableStream({
    async start(controller) {
      // Shared close state — `cleanup` is the single path that ends this
      // stream, regardless of whether the trigger was a terminal event,
      // a client disconnect (via cancel), or an error.
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed by upstream */
        }
      };

      const send = (bev: BufferedEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(bev) + "\n")
          );
        } catch {
          // Stream went away (client disconnect race) — just stop.
          cleanup();
        }
      };

      const sendHeartbeat = () => {
        if (closed) return;
        try {
          const payload: StreamResponse = { type: "heartbeat" };
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(payload) + "\n")
          );
        } catch {
          cleanup();
        }
      };

      // Heartbeat keeps the underlying TCP / proxy connection alive
      // during long idle stretches (model thinking, canUseTool waiting
      // on the user).
      const HEARTBEAT_MS = 15_000;
      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

      const cb = (bev: BufferedEvent) => {
        send(bev);
        const t = bev.event.type;
        if (t === "done" || t === "error" || t === "aborted") {
          // Defer to next microtask so any synchronously-following
          // events (rare, but possible during replay) flush first.
          queueMicrotask(cleanup);
        }
      };

      unsubscribe = subscribeToTask(taskId, fromSeq, cb);
      if (!unsubscribe) {
        // Task disappeared between the initial getTask check and now.
        warn("Chat stream: task vanished mid-subscribe:", { taskId });
        cleanup();
        return;
      }
      // If subscribeToTask saw a non-running status, it returned a
      // unsubscribe that's just a no-op — replay delivered any buffered
      // terminal event, and `cb` already queued cleanup via microtask.

      // ───── Re-emit still-pending permission_requests at seq < fromSeq ─────
      //
      // Without this, a client that disconnected AFTER seeing a permission
      // prompt and then reattaches with `from=lastSeq+1` would never see
      // the prompt again — the event sits at an old seq, replay skips it,
      // and the SDK call hangs forever waiting on a decision the user
      // can't make. Walk the buffer for permission_request events whose
      // server-side Promise is still pending and re-emit them so the
      // frontend modal reopens.
      //
      // We use the event's ORIGINAL seq. The frontend's client-side seq
      // tracker only advances on strictly-increasing seqs (see
      // useClaudeStreaming.attachToTask), so this re-emit doesn't regress
      // the cursor — it just feeds the permission event through the
      // normal processor path.
      const liveTask = getTask(taskId);
      if (liveTask && fromSeq > 0) {
        let rebroadcast = 0;
        for (const bev of liveTask.events) {
          if (bev.seq >= fromSeq) break;
          if (bev.event.type !== "permission_request") continue;
          const payload = bev.event.data as { id?: string } | undefined;
          if (!payload?.id) continue;
          if (!isPending(payload.id)) continue;
          send(bev);
          rebroadcast++;
        }
        if (rebroadcast > 0) {
          info("Re-broadcast pending permissions on reattach:", {
            taskId,
            fromSeq,
            count: rebroadcast,
          });
        }
      }
    },
    cancel() {
      // Client disconnected. The `cleanup` closure inside `start` is
      // unreachable from here, but the broken `controller.enqueue` on
      // next event will trigger cleanup() via the catch branch above.
      // The heartbeat tick (every 15s) will also catch the closed
      // controller and self-clean. In the worst case the timer fires
      // once or twice before the next tick — harmless.
    },
  });

  return c.newResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/chat/active?workingDirectory=<path>
 *
 * Returns active tasks for a given workspace, so the frontend can
 * auto-reattach to in-flight work on workspace open / page reload.
 * Pass `workingDirectory` to scope; omit to list everything (debug only).
 */
export async function handleActiveTasksRequest(c: Context) {
  const workingDirectory = c.req.query("workingDirectory") || undefined;
  const tasks = listActiveTasks(workingDirectory);
  return c.json({ tasks });
}
