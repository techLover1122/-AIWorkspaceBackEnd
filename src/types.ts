export interface AppConfig {
  port: number;
  host: string;
  debug: boolean;
  claudePath?: string;
}

export interface StreamResponse {
  type:
    | "claude_json"
    | "error"
    | "done"
    | "aborted"
    | "permission_request"
    // Emitted every ~15s while the SDK is busy (model thinking) or waiting
    // on a permission decision. Pure side-effect: keeps the HTTP stream
    // alive past proxy idle timeouts (Traefik / Cloudflare / nginx all
    // default to ~60s) so the frontend doesn't see a spurious disconnect.
    // Frontend's stream parser ignores it.
    | "heartbeat";
  data?: unknown;
  error?: string;
}

export interface ChatAttachmentPayload {
  /** Mime type, e.g. "image/png" / "image/jpeg" — passed straight through
   *  to Anthropic's image-source `media_type`. */
  mediaType: string;
  /** Base64-encoded bytes (no `data:` prefix). */
  base64: string;
  /** Original filename, for logging + chat metadata. */
  name: string;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /** Image attachments — sent to Claude as multimodal content blocks
   *  instead of file mentions. */
  attachments?: ChatAttachmentPayload[];
}

export interface ProjectInfo {
  path: string;
  encodedName: string;
}

export interface ConversationSummary {
  sessionId: string;
  startTime: string;
  lastTime: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface HistoryLine {
  /** "user" | "assistant" | "system" | "result" are the canonical chat types.
   *  Newer transcripts also include housekeeping lines like "queue-operation",
   *  "attachment", "file-history-snapshot", "ai-title", "last-prompt" — kept
   *  open as `string` so we don't have to chase the schema. */
  type: string;
  message?: unknown;
  timestamp?: string;
  uuid?: string;
  sessionId?: string;
}
