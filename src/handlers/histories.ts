import { Context } from "hono";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationSummary, HistoryLine } from "../types.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Strip the `<ide_opened_file>…</ide_opened_file>` and similar IDE-injected
 *  tags so the preview shows the user's actual prompt instead of system noise. */
function stripSystemTags(s: string): string {
  return s
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/gi, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .trim();
}

/** Pull a human-readable preview from a single jsonl message line. */
function previewFromMessage(line: HistoryLine | undefined): string {
  if (!line || line.type !== "user") return "";
  const msg = line.message as
    | { content?: unknown; text?: string; role?: string }
    | undefined;
  if (!msg) return "";

  // Legacy shape: { text: "…" }.
  if (typeof msg.text === "string" && msg.text.trim()) {
    return stripSystemTags(msg.text).slice(0, 120);
  }
  const content = msg.content;
  // String content (some older transcripts).
  if (typeof content === "string") return stripSystemTags(content).slice(0, 120);
  // Array of content blocks — pick the first text block that survives the
  // system-tag strip (i.e. is the user's actual prompt, not IDE metadata).
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text"
      ) {
        const t = (block as { text?: string }).text;
        if (typeof t === "string") {
          const cleaned = stripSystemTags(t);
          if (cleaned) return cleaned.slice(0, 120);
        }
      }
    }
  }
  return "";
}

export async function handleHistoriesRequest(c: Context) {
  const encodedName = c.req.param("encodedProjectName");
  if (!encodedName) return c.json({ conversations: [] });
  const historyDir = join(CLAUDE_PROJECTS_DIR, encodedName);

  let files: string[];
  try {
    files = (await readdir(historyDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return c.json({ conversations: [] });
  }

  const conversations: ConversationSummary[] = [];
  for (const file of files) {
    try {
      const content = await readFile(join(historyDir, file), "utf-8");
      const lines: HistoryLine[] = content
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as HistoryLine;
          } catch {
            return null;
          }
        })
        .filter((l): l is HistoryLine => l !== null);

      // Filename is the authoritative sessionId — the CLI names every
      // transcript `<sessionId>.jsonl`. Don't read it out of a per-message
      // field like `uuid` (that's per-line, often undefined on the new
      // metadata line types: queue-operation, ai-title, etc.).
      const sessionId = file.replace(/\.jsonl$/i, "");

      // Counts and previews should reflect actual user/assistant turns —
      // skip housekeeping line types so the UI doesn't say "59 messages"
      // when only 10 were the user's.
      const turnLines = lines.filter(
        (l) => l.type === "user" || l.type === "assistant"
      );
      const userTurns = turnLines.filter((l) => l.type === "user");

      // Timestamps from any line that has one (newer files may put metadata
      // lines at the very start without timestamps).
      const timed = lines.filter(
        (l) => typeof l.timestamp === "string" && l.timestamp.length > 0
      );

      let startTime = timed[0]?.timestamp ?? "";
      let lastTime = timed[timed.length - 1]?.timestamp ?? "";

      // Fall back to file mtime when timestamps are missing — keeps the
      // session sortable + dated even for very fresh files.
      if (!lastTime) {
        try {
          const s = await stat(join(historyDir, file));
          lastTime = new Date(s.mtimeMs).toISOString();
          if (!startTime) startTime = lastTime;
        } catch {
          /* ignore */
        }
      }

      // Prefer the user's first prompt as the preview — most recognizable.
      // Fall back to the most recent user turn if the first is empty.
      let preview = previewFromMessage(userTurns[0]);
      if (!preview && userTurns.length > 0) {
        preview = previewFromMessage(userTurns[userTurns.length - 1]);
      }

      conversations.push({
        sessionId,
        startTime,
        lastTime,
        messageCount: turnLines.length,
        lastMessagePreview: preview,
      });
    } catch {
      // Skip unreadable / malformed transcript — don't kill the whole list.
    }
  }

  conversations.sort(
    (a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime()
  );

  return c.json({ conversations });
}
