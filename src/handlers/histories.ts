import { Context } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationSummary, HistoryLine } from "../types.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

function extractSummary(lines: HistoryLine[]): ConversationSummary {
  const first = lines[0];
  const last = lines[lines.length - 1];
  return {
    sessionId: first?.uuid ?? "unknown",
    startTime: first?.timestamp ?? "",
    lastTime: last?.timestamp ?? "",
    messageCount: lines.length,
    lastMessagePreview:
      last?.type === "user"
        ? String((last.message as { text?: string })?.text ?? "").slice(0, 80)
        : "",
  };
}

export async function handleHistoriesRequest(c: Context) {
  const encodedName = c.req.param("encodedProjectName");
  if (!encodedName) return c.json({ conversations: [] });
  const historyDir = join(CLAUDE_PROJECTS_DIR, encodedName);

  try {
    const files = await readdir(historyDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    const seen = new Set<string>();
    const conversations: ConversationSummary[] = [];

    for (const file of jsonlFiles) {
      const content = await readFile(join(historyDir, file), "utf-8");
      const lines: HistoryLine[] = content
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      if (lines.length === 0) continue;

      const summary = extractSummary(lines);
      if (seen.has(summary.sessionId)) continue;
      seen.add(summary.sessionId);
      conversations.push(summary);
    }

    conversations.sort(
      (a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime()
    );

    return c.json({ conversations });
  } catch {
    return c.json({ conversations: [] });
  }
}
