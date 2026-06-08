/**
 * Server → Frontend event bus, delivered via SSE.
 *
 * Backend tools (e.g. the open_tab MCP tool) call `publishEvent({...})` to
 * push commands like "open this URL as a tab" to the running frontend. The
 * frontend subscribes once at app startup to `/api/events` and processes
 * each event as it arrives.
 */

import type { Context } from "hono";

export type ClientEvent =
  | { type: "open_tab"; url: string; label: string }
  | { type: "bookmark_added"; url: string; name: string | null }
  | { type: "bookmark_deleted"; id: number }
  | {
      type: "pack_installed";
      name: string;
      slug: string;
      description: string;
      hasInstall: boolean;
      installedAt: string;
    }
  | { type: "task_started"; taskId: string; origin: string };

type Subscriber = (e: ClientEvent) => void;

const subscribers = new Set<Subscriber>();

export function publishEvent(event: ClientEvent): void {
  for (const s of subscribers) {
    try { s(event); } catch { /* ignore */ }
  }
}

export function handleEvents(c: Context) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const write = (data: string) => {
        try { controller.enqueue(enc.encode(data)); } catch { /* closed */ }
      };

      // Keep-alive ping every 25s so proxies don't drop the connection.
      const keepAlive = setInterval(() => write(`: ping\n\n`), 25000);

      const sub: Subscriber = (event) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
      };
      subscribers.add(sub);

      // Initial hello so the client knows the channel is up.
      write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

      // Cleanup on disconnect — Hono signals via the abort signal.
      c.req.raw.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive);
        subscribers.delete(sub);
        try { controller.close(); } catch { /* already closed */ }
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
