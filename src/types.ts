export interface AppConfig {
  port: number;
  host: string;
  debug: boolean;
  claudePath?: string;
}

export interface StreamResponse {
  type: "claude_json" | "error" | "done" | "aborted" | "permission_request";
  data?: unknown;
  error?: string;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
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
