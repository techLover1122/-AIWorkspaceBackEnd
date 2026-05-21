import { Context } from "hono";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistoryLine } from "../types.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export async function handleConversationRequest(c: Context) {
  const encodedName = c.req.param("encodedProjectName");
  const sessionId = c.req.param("sessionId");
  if (!encodedName || !sessionId) {
    return c.json({ error: "Missing parameters" }, 400);
  }
  const filePath = join(CLAUDE_PROJECTS_DIR, encodedName, `${sessionId}.jsonl`);

  try {
    const content = await readFile(filePath, "utf-8");
    const lines: HistoryLine[] = content
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // Lines without timestamps (queue-operation, ai-title, …) sort to the
    // start so they don't shuffle the actual conversation order.
    const ts = (l: HistoryLine) =>
      l.timestamp ? new Date(l.timestamp).getTime() : 0;
    const sorted = lines.sort((a, b) => ts(a) - ts(b));

    return c.json({
      sessionId,
      messages: sorted,
      metadata: {
        startTime: sorted[0]?.timestamp ?? "",
        endTime: sorted[sorted.length - 1]?.timestamp ?? "",
        messageCount: sorted.length,
      },
    });
  } catch {
    return c.json(
      { error: "Conversation not found" },
      404
    );
  }
}
