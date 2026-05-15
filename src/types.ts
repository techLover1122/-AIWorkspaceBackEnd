export interface AppConfig {
  port: number;
  host: string;
  debug: boolean;
  claudePath?: string;
}

export interface StreamResponse {
  type: "claude_json" | "error" | "done" | "aborted";
  data?: unknown;
  error?: string;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: "default" | "plan" | "acceptEdits";
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
  type: "user" | "assistant" | "system" | "result";
  message: unknown;
  timestamp: string;
  uuid: string;
}
