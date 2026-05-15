import { Context } from "hono";
import { query } from "@anthropic-ai/claude-code";
import type { ChatRequest, StreamResponse } from "../types.js";
import { debug, error as logError } from "../utils/logger.js";

const abortControllers = new Map<string, AbortController>();

export function abortRequest(requestId: string): boolean {
  const controller = abortControllers.get(requestId);
  if (!controller) return false;
  controller.abort();
  abortControllers.delete(requestId);
  return true;
}

export async function handleChatRequest(c: Context) {
  const body = (await c.req.json()) as ChatRequest;
  const { message, sessionId, requestId, allowedTools, workingDirectory, permissionMode } = body;

  debug("Chat request:", { requestId, sessionId, permissionMode, workingDirectory });

  const abortController = new AbortController();
  abortControllers.set(requestId, abortController);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: StreamResponse) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
      };

      try {
        const claudePath = process.env.CLAUDE_PATH;
        const response = query({
          prompt: message,
          options: {
            abortController,
            ...(sessionId ? { resume: sessionId } : {}),
            ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
            ...(workingDirectory ? { cwd: workingDirectory } : {}),
            ...(allowedTools?.length ? { allowedTools } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          },
        });

        for await (const sdkMessage of response) {
          send({ type: "claude_json", data: sdkMessage });
        }

        send({ type: "done" });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          send({ type: "aborted" });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          logError("Chat error:", msg);
          send({ type: "error", error: msg });
        }
      } finally {
        abortControllers.delete(requestId);
        controller.close();
      }
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

export async function handleAbortRequest(c: Context) {
  const requestId = c.req.param("requestId");
  const success = abortRequest(requestId);
  return c.json({ success });
}
