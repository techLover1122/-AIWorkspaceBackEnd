import { Context } from "hono";
import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectInfo } from "../types.js";
import { debug } from "../utils/logger.js";

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

function encodeName(name: string): string {
  return Buffer.from(name, "utf-8")
    .toString("base64url")
    .replace(/=+$/, "");
}

export async function handleProjectsRequest(c: Context) {
  try {
    await access(CLAUDE_CONFIG_PATH);
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    const projects: ProjectInfo[] = [];

    const projectPaths = config.projects ?? config.projectPaths ?? [];
    for (const projectPath of projectPaths) {
      const encodedName = encodeName(projectPath);
      const historyDir = join(CLAUDE_PROJECTS_DIR, encodedName);

      try {
        await access(historyDir);
        projects.push({ path: projectPath, encodedName });
      } catch {
        debug("No history for project:", projectPath);
      }
    }

    return c.json({ projects });
  } catch {
    return c.json({ projects: [] });
  }
}
