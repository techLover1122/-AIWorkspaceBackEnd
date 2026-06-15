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
    | "permission_resolved"
    | "token_usage"
    | "heartbeat"
    // Intent Guard Agent: fires before query() when the user's message is
    // ambiguous. data: IntentGuardRequestPayload. Frontend shows a two-option
    // clarification modal; user's choice is POSTed to /api/intent-guard/:id.
    | "intent_guard_request"
    // Companion to intent_guard_request: resolved server-side (auto-resolved
    // on timeout or task abort). data: { id, choice: "narrow"|"broad"|"auto" }.
    | "intent_guard_resolved"
    // Anomaly Detection Agent: fires after all tools complete when the
    // executed actions don't match the user's captured intent.
    // data: AnomalyAlertPayload.
    | "anomaly_alert";
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
  /** Model id the turn should run on (e.g. "claude-opus-4-8"). When unset
   *  the SDK falls back to its default model. Switched from the chat panel
   *  via the /model command. */
  model?: string;
  /** Image attachments — sent to Claude as multimodal content blocks
   *  instead of file mentions. */
  attachments?: ChatAttachmentPayload[];
  /** Where the turn was started. "whatsapp" means an inbound WhatsApp
   *  message kicked off this chat — replies / permission prompts /
   *  AskUserQuestion blocks for this turn route straight back to
   *  WhatsApp, bypassing the presence + 5-min-idle gate. Default
   *  (undefined) keeps the gated behavior. */
  origin?: "whatsapp";
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
  title?: string;
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
