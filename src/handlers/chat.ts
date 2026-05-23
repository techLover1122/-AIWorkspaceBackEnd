import { Context } from "hono";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import type { ChatRequest, StreamResponse } from "../types.js";
import { info, warn, error as logError } from "../utils/logger.js";
import { recordSession } from "../utils/db.js";
import { createAiideMcpServer } from "../mcp/aiideTools.js";
import {
  createPendingPermission,
  denyPending,
  type PermissionRequestPayload,
} from "./permission.js";

// MCP tool names must be prefixed with `mcp__<server>__` in allowedTools.
const MCP_TOOL_NAMES = [
  "mcp__aiide__open_tab",
  "mcp__aiide__register_service",
  "mcp__aiide__list_services",
  "mcp__aiide__add_bookmark",
  "mcp__aiide__list_bookmarks",
  "mcp__aiide__delete_bookmark",
  "mcp__aiide__scan_ports",
  "mcp__aiide__create_pack",
];

/**
 * Workspace-environment context appended to every chat request's system
 * prompt. Without this the model treats the box as a normal Linux VM and
 * writes code with `http://localhost:<port>` URLs — which the user's
 * browser can't reach, since it's on a different origin (the edge proxy).
 *
 * Filled at request time from env so it reflects this specific workspace.
 */
function buildProxyContext(): string | null {
  const userId = process.env.USER_ID;
  const domain = process.env.PLATFORM_DOMAIN;
  if (!userId || !domain) return null;

  const base = (name: string) => `http://${name}-${userId}.${domain}`;
  return [
    "# Workspace environment",
    "",
    "This workspace runs behind an edge proxy + per-user Traefik. Every HTTP",
    "service exposed here is reachable from the user's browser ONLY through a",
    "public subdomain — `http://localhost:<port>` URLs are NOT reachable from",
    "the browser (the user is on a different origin).",
    "",
    "## Default service URLs",
    "",
    `- Frontend (Next.js, port 3000):  ${base("frontend")}`,
    `- Backend API (Hono, port 8090):  ${base("api")}`,
    `- code-server / IDE (port 8080):  ${base("ide")}`,
    "",
    "## Adding a new service",
    "",
    "When you start any new HTTP service in this workspace (a dev server, an",
    "API, a Storybook, anything):",
    "",
    "1. Bind it to localhost or 0.0.0.0 on any unprivileged port — the port",
    "   itself doesn't matter.",
    "2. Register the port using the `register_service` MCP tool, e.g.",
    "   `register_service(port=5173)`. The tool returns the public URL.",
    "3. Use that URL — NOT `http://localhost:5173` — wherever the browser",
    "   needs to reach the service (fetch calls, iframe src, links, etc.).",
    "",
    "If you skip step 2, the user's browser will get DNS / CORS errors when",
    "your code tries to fetch the new service.",
    "",
    `## Auto-generated subdomain convention\n\nAny port \`P\` registered without an explicit name becomes\n  \`http://port-P-${userId}.${domain}\`\n`,
    "## CORS",
    "",
    `The browser's origin is \`${base("frontend")}\`. Any backend service`,
    "that needs to receive cross-origin XHR from the frontend must send",
    "CORS headers permitting that origin (or `*`). The default backend at",
    `\`${base("api")}\` already does this.`,
    "",
    "## Don't",
    "",
    "- Don't hardcode `localhost` or `127.0.0.1` URLs in browser-facing code.",
    "- Don't write Vite/Webpack dev-server configs that print",
    "  `http://localhost:<port>` as the dev URL — the user will copy-paste it",
    "  and get a CORS / DNS error. Either reconfigure them to print the",
    "  registered public URL, or remind the user of the public URL after",
    "  registering.",
    "- Don't try to bind privileged ports (<1024). Port 80 is owned by",
    "  Traefik; don't fight it.",
  ].join("\n");
}

// Tools whose response path we don't wire through our frontend. Populate as
// new ones surface. AskUserQuestion now has a custom modal handler in the
// frontend that intercepts the tool_use block, shows a popup, and sends the
// user's answer back as a follow-up chat message — so it stays allowed.
const DISALLOWED_TOOLS: string[] = [
];

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
  const {
    message,
    sessionId,
    requestId,
    allowedTools,
    workingDirectory,
    permissionMode,
    attachments,
  } = body;

  // Only use cwd if it actually exists — a missing cwd causes ENOENT on spawn.
  const safeCwd = workingDirectory && existsSync(workingDirectory) ? workingDirectory : undefined;
  if (workingDirectory && !safeCwd) {
    warn(`Working directory does not exist, ignoring: ${workingDirectory}`);
  }

  const isContinue = typeof message === "string" && message.trim() === "continue";
  info("Chat request:", {
    requestId,
    sessionId: sessionId ?? null,
    isContinue,
    permissionMode: permissionMode ?? null,
    workingDirectory: safeCwd ?? null,
    callerAllowedTools: allowedTools ?? [],
    messagePreview: typeof message === "string" ? message.slice(0, 120) : null,
  });

  const abortController = new AbortController();
  abortControllers.set(requestId, abortController);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: StreamResponse) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
      };

      // Track every pending permission we open so we can auto-deny on
      // stream abort (otherwise the SDK call hangs forever).
      const openPermissions = new Set<string>();

      // The structured permission callback. Replaces the regex-based
      // is_error parsing — SDK calls this for any tool that needs approval
      // and we surface a permission_request stream event with full context.
      const canUseTool: CanUseTool = async (toolName, input, options) => {
        const { id, promise } = createPendingPermission({
          toolUseId: options.toolUseID,
          toolName,
          input,
        });
        openPermissions.add(id);

        const payload: PermissionRequestPayload = {
          id,
          toolUseId: options.toolUseID,
          toolName,
          input,
          title: options.title,
          displayName: options.displayName,
          description: options.description,
          blockedPath: options.blockedPath,
          decisionReason: options.decisionReason,
          suggestions: options.suggestions,
        };
        info("SDK canUseTool fired:", {
          requestId,
          id,
          toolName,
          toolUseId: options.toolUseID,
          blockedPath: options.blockedPath,
          decisionReason: options.decisionReason,
          suggestionCount: options.suggestions?.length ?? 0,
        });
        send({ type: "permission_request", data: payload });

        // If the SDK signals abort while we're waiting on the user, deny.
        const onAbort = () => {
          if (denyPending(id, "Aborted by user")) {
            openPermissions.delete(id);
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await promise;
          openPermissions.delete(id);
          return result;
        } finally {
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      try {
        const claudePath = process.env.CLAUDE_PATH;
        // Always make AI-IDE skills available; merge with any caller-allowed tools.
        const mergedAllowedTools = [
          ...MCP_TOOL_NAMES,
          ...(allowedTools ?? []),
        ];
        info("Invoking SDK query:", {
          requestId,
          mergedAllowedTools,
          resume: sessionId ?? null,
          isContinue,
        });
        // When the user sends images, hand them to Claude as proper
        // multimodal content blocks (base64 image sources). The default
        // string prompt would only carry the text — Claude would see
        // filenames like "annotation-12345.png" and try to Read them off
        // disk, which fails ("File does not exist").
        const promptInput =
          attachments && attachments.length > 0
            ? (async function* () {
                yield {
                  type: "user" as const,
                  parent_tool_use_id: null,
                  message: {
                    role: "user" as const,
                    content: [
                      { type: "text" as const, text: message },
                      ...attachments.map((a) => ({
                        type: "image" as const,
                        source: {
                          type: "base64" as const,
                          media_type: a.mediaType as
                            | "image/png"
                            | "image/jpeg"
                            | "image/gif"
                            | "image/webp",
                          data: a.base64,
                        },
                      })),
                    ],
                  },
                  // Required field on SDKUserMessage even though we don't
                  // have a session — the SDK fills this in when streaming.
                  session_id: sessionId ?? "",
                };
              })()
            : message;
        const proxyContext = buildProxyContext();
        const response = query({
          prompt: promptInput,
          options: {
            abortController,
            ...(sessionId ? { resume: sessionId } : {}),
            ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
            ...(safeCwd ? { cwd: safeCwd } : {}),
            allowedTools: mergedAllowedTools,
            disallowedTools: DISALLOWED_TOOLS,
            mcpServers: { aiide: createAiideMcpServer({ workspaceDir: safeCwd }) },
            canUseTool,
            ...(permissionMode ? { permissionMode } : {}),
            // Inject workspace-environment context (proxy URLs, port
            // registration, CORS) so the model writes code that works in
            // this multi-tenant environment instead of hard-coding
            // localhost:port URLs the browser can't reach.
            ...(proxyContext ? { appendSystemPrompt: proxyContext } : {}),
          },
        });

        let detectedSessionId: string | null = sessionId ?? null;
        let messageCount = 0;
        for await (const sdkMessage of response) {
          send({ type: "claude_json", data: sdkMessage });
          const msg = sdkMessage as unknown as {
            session_id?: string;
            type?: string;
            message?: { content?: Array<Record<string, unknown>> };
          };
          if (msg.session_id) detectedSessionId = msg.session_id;
          if (msg.type === "assistant" || msg.type === "user") messageCount++;
          // Authoritative auto-deny signal from the SDK.
          if (msg.type === "system") {
            const sysMsg = sdkMessage as unknown as {
              subtype?: string;
              tool_name?: string;
              tool_use_id?: string;
              decision_reason?: string;
              decision_reason_type?: string;
              message?: string;
            };
            if (sysMsg.subtype === "permission_denied") {
              warn("SDK permission_denied:", {
                requestId,
                tool: sysMsg.tool_name,
                tool_use_id: sysMsg.tool_use_id,
                reasonType: sysMsg.decision_reason_type,
                reason: sysMsg.decision_reason,
                message: sysMsg.message,
              });
            }
          }
          // Log every tool call + tool result so the backend console shows the
          // exact SDK signal that lead to a permission UI / error in the chat.
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const t = block.type as string | undefined;
              if (t === "tool_use") {
                info("SDK tool_use:", {
                  requestId,
                  name: block.name,
                  id: block.id,
                  input: block.input,
                });
                // Extra-loud log for AskUserQuestion so it's easy to spot in
                // the backend terminal when debugging the modal flow.
                if (block.name === "AskUserQuestion") {
                  const qs =
                    (block.input as { questions?: Array<{ header?: string; question?: string }> })
                      ?.questions ?? [];
                  info("SDK AskUserQuestion detected:", {
                    requestId,
                    tool_use_id: block.id,
                    questionCount: qs.length,
                    headers: qs.map((q) => q.header),
                    note: "Frontend modal will intercept; this SDK call will auto-error and be suppressed.",
                  });
                }
              } else if (t === "tool_result") {
                const isErr = (block.is_error as boolean) ?? false;
                let txt = "";
                if (typeof block.content === "string") {
                  txt = block.content;
                } else if (Array.isArray(block.content)) {
                  txt = (block.content as Array<Record<string, unknown>>)
                    .map((c) => (typeof c === "string" ? c : ((c?.text as string) ?? "")))
                    .filter(Boolean)
                    .join("\n");
                }
                if (isErr) {
                  warn("SDK tool_result ERROR:", {
                    requestId,
                    tool_use_id: block.tool_use_id,
                    text: txt.slice(0, 500),
                    // Dump the full raw block so empty-body denials are
                    // visible (text/content-shape is hard to infer otherwise).
                    rawBlock: JSON.stringify(block).slice(0, 2000),
                  });
                } else {
                  info("SDK tool_result ok:", {
                    requestId,
                    tool_use_id: block.tool_use_id,
                  });
                }
              }
            }
          }
        }

        // Persist session metadata after stream completes
        if (detectedSessionId) {
          try { recordSession(detectedSessionId, safeCwd ?? null, messageCount); } catch { /* ignore */ }
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
        // Drain any permission prompts that were never answered (otherwise
        // their pending entries leak across requests).
        for (const id of openPermissions) {
          denyPending(id, "Stream ended without a decision");
        }
        openPermissions.clear();
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
  if (!requestId) return c.json({ success: false }, 400);
  const success = abortRequest(requestId);
  return c.json({ success });
}
