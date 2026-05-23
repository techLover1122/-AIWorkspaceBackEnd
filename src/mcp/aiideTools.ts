/**
 * In-process MCP server exposing AI-IDE workspace skills to Claude.
 *
 * Tools:
 *   - open_tab(url, label?)        — opens a URL as a workspace tab
 *   - add_bookmark(url, name?)     — saves a URL to the new-tab-page
 *   - list_bookmarks()             — returns the user's saved URLs
 *   - delete_bookmark(id)          — removes a saved URL
 *   - scan_ports()                 — lists currently-running web servers
 *   - create_pack(name, ...)       — scaffold a Claude-Code-style "environment
 *                                    pack" (SKILL.md + INSTALL.md) in the
 *                                    project's .claude/skills/ directory
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  addUrl,
  listUrls,
  deleteUrl as dbDeleteUrl,
  setUrlOpenedByUrl,
} from "../utils/db.js";
import { scanWebPorts } from "../handlers/ports.js";
import { publishEvent } from "../handlers/events.js";
import { registerServicePort } from "../handlers/services.js";

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (/^\d+$/.test(url)) return `http://localhost:${url}`;
  if (!/^https?:\/\//i.test(url)) return `http://${url}`;
  return url;
}

/**
 * If `url` points at a local port (localhost / 127.0.0.1 / the workspace's
 * own public IP/host on :<port>), register that port as a service via the
 * proxy router and return the public domain URL. Otherwise return the URL
 * unchanged. Registration failures fall back silently to the original URL
 * so external sites and pre-existing public URLs aren't broken.
 */
async function toPublicServiceUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(parsed.protocol)) return url;
  if (!parsed.port) return url;

  // Only register hosts that resolve to this workspace. Anything else
  // (e.g. example.com:8080) keeps its original URL.
  const localHosts = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "[::1]",
    process.env.INSTANCE_IP ?? "",
    process.env.PUBLIC_IP ?? "",
    process.env.PUBLIC_HOSTNAME ?? "",
  ]);
  if (!localHosts.has(parsed.hostname)) return url;

  const port = Number(parsed.port);
  const svc = await registerServicePort(port);
  if (!svc) return url;
  // Preserve the original path/query/hash on the new host.
  return `${svc.url}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "pack"
  );
}

function escapeYaml(s: string): string {
  // YAML scalar: wrap in double quotes and escape backslash/quote/newline.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

export const openTabTool = tool(
  "open_tab",
  "Open a URL as a tab in the AI-IDE workspace. Use this when the user asks to open, view, navigate to, visit, or add a tab for any website or local server. Accepts full URLs (https://example.com), host:port pairs (localhost:3000), or bare ports (5173). Also auto-saves the URL to the user's bookmarks.",
  {
    url: z
      .string()
      .describe("URL, host:port, or bare port number to open. Examples: 'https://wikipedia.org', 'localhost:5173', '3000'."),
    label: z
      .string()
      .optional()
      .describe("Optional display label for the tab. If omitted, the hostname is used."),
  },
  async ({ url, label }) => {
    // First resolve a bare port / host:port to a full URL, then convert
    // any local-port URL into its public domain equivalent (auto-
    // registering the port as a service if it's not already known).
    const fullUrl = await toPublicServiceUrl(normalizeUrl(url));
    const displayLabel = label && label.trim() ? label.trim() : hostOf(fullUrl);

    // Save as bookmark + mark opened in DB so it survives reload.
    addUrl(fullUrl, displayLabel, null);
    setUrlOpenedByUrl(fullUrl, true);

    // Signal the frontend via SSE.
    publishEvent({ type: "open_tab", url: fullUrl, label: displayLabel });

    return {
      content: [
        { type: "text", text: `Opened ${displayLabel} (${fullUrl}) as a new tab.` },
      ],
    };
  }
);

export const addBookmarkTool = tool(
  "add_bookmark",
  "Save a URL to the user's bookmarks (visible on the new-tab page). Use this when the user asks to save, bookmark, remember, or store a link without necessarily opening it. Metadata (title, favicon) is fetched automatically.",
  {
    url: z.string().describe("URL to save. Full URLs, host:port, and bare ports are all accepted."),
    name: z
      .string()
      .optional()
      .describe("Optional display name. If omitted, the page <title> is fetched automatically."),
  },
  async ({ url, name }) => {
    const fullUrl = normalizeUrl(url);
    const row = addUrl(fullUrl, name ?? null, null);
    publishEvent({ type: "bookmark_added", url: row.url, name: row.name });
    return {
      content: [
        {
          type: "text",
          text: `Saved bookmark: ${row.name ?? row.url}. It will appear on the new-tab page.`,
        },
      ],
    };
  }
);

export const listBookmarksTool = tool(
  "list_bookmarks",
  "List all URLs the user has saved as bookmarks on the new-tab page.",
  {},
  async () => {
    const rows = listUrls();
    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No bookmarks saved yet." }] };
    }
    const lines = rows.map(
      (r) => `- ${r.name ?? hostOf(r.url)} → ${r.url}${r.opened ? "  [open]" : ""}`
    );
    return {
      content: [
        { type: "text", text: `${rows.length} bookmark(s):\n${lines.join("\n")}` },
      ],
    };
  }
);

export const deleteBookmarkTool = tool(
  "delete_bookmark",
  "Remove a saved URL from the user's bookmarks by its numeric id (use list_bookmarks first to find the id).",
  {
    id: z.number().int().describe("Numeric id of the bookmark to remove."),
  },
  async ({ id }) => {
    dbDeleteUrl(id);
    publishEvent({ type: "bookmark_deleted", id });
    return { content: [{ type: "text", text: `Removed bookmark id=${id}.` }] };
  }
);

export const scanPortsTool = tool(
  "scan_ports",
  "Scan the local machine for running web servers and return only the ports that actually serve a web UI. Use this when the user asks 'what's running', 'list ports', 'which servers are up', or wants to know what dev servers are currently active.",
  {},
  async () => {
    const ports = await scanWebPorts();
    if (ports.length === 0) {
      return { content: [{ type: "text", text: "No web servers detected." }] };
    }
    const lines = ports.map((p) => {
      const name = p.title || p.appLabel || (p.processName ?? "").replace(/\.exe$/i, "") || "Server";
      return `- :${p.port}  ${name}  → http://localhost:${p.port}`;
    });
    return {
      content: [
        {
          type: "text",
          text: `Detected ${ports.length} running web server(s):\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

/**
 * Build a `create_pack` tool bound to a workspace directory. The tool scaffolds
 * a project-local Claude-Code-style "environment pack" (SKILL.md + INSTALL.md)
 * under `<workspaceDir>/.claude/skills/<slug>/`. After scaffolding, the user is
 * reminded that they can promote the pack to `~/.claude/skills/` for cross-
 * project reuse.
 */
function makeCreatePackTool(workspaceDir: string | undefined) {
  return tool(
    "create_pack",
    "Scaffold a new project-local environment pack (a Claude-Code-style skill folder containing SKILL.md and INSTALL.md). The pack is created under the current project's .claude/skills/<slug>/. Use this when the user wants to author a new skill or environment pack. After creation, remind the user they can promote the pack to ~/.claude/skills/ for cross-project use.",
    {
      name: z
        .string()
        .min(1)
        .describe("Human-readable name of the pack (e.g. 'Postgres Local Dev'). Will be slugified to derive the folder name."),
      description: z
        .string()
        .min(1)
        .describe("One-line description of what the pack provides — written into SKILL.md frontmatter and used by Claude when deciding when to load the skill."),
      body: z
        .string()
        .optional()
        .describe("Optional Markdown body for SKILL.md. Should describe what the skill does and when to use it. If omitted, a stub is written."),
      installSteps: z
        .array(z.string())
        .optional()
        .describe("Optional ordered list of shell commands or instructions. Written as a numbered list into INSTALL.md."),
      installNotes: z
        .string()
        .optional()
        .describe("Optional free-form Markdown prepended to INSTALL.md (prerequisites, caveats, verification tips)."),
    },
    async ({ name, description, body, installSteps, installNotes }) => {
      if (!workspaceDir) {
        return {
          content: [
            {
              type: "text",
              text: "No working directory is set for this chat session, so I can't create a project-local pack. Pick a project from the workspace picker first.",
            },
          ],
        };
      }

      const slug = slugify(name);
      const skillsRoot = join(workspaceDir, ".claude", "skills");
      const target = join(skillsRoot, slug);

      if (existsSync(target)) {
        return {
          content: [
            {
              type: "text",
              text: `An environment pack already exists at ${target}. Pick a different name or delete the existing folder first.`,
            },
          ],
        };
      }

      try {
        mkdirSync(target, { recursive: true });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create directory ${target}: ${(err as Error).message}`,
            },
          ],
        };
      }

      const skillMd =
        `---\n` +
        `name: ${escapeYaml(slug)}\n` +
        `description: ${escapeYaml(description)}\n` +
        `---\n\n` +
        `# ${name}\n\n` +
        (body && body.trim()
          ? `${body.trim()}\n`
          : `${description}\n\n## When to use\n\nDescribe when Claude should load this skill.\n\n## What it provides\n\nList the capabilities, commands, or context this pack makes available.\n`);

      const installLines: string[] = [];
      installLines.push(`# Install — ${name}\n`);
      if (installNotes && installNotes.trim()) {
        installLines.push(installNotes.trim(), "");
      }
      if (installSteps && installSteps.length > 0) {
        installLines.push("## Steps\n");
        installSteps.forEach((step, i) => {
          installLines.push(`${i + 1}. ${step}`);
        });
        installLines.push("");
      } else {
        installLines.push(
          "## Steps\n",
          "_TODO: Document the install steps for this pack. Each step should be a single shell command or short instruction. Claude will run these with your approval._\n",
          "1. _Add the first step here_",
          ""
        );
      }
      installLines.push(
        "## Verification\n",
        "_TODO: Describe how to verify the install succeeded (e.g. `node --version` returns >= 18)._\n"
      );
      const installMd = installLines.join("\n");

      try {
        writeFileSync(join(target, "SKILL.md"), skillMd, "utf8");
        writeFileSync(join(target, "INSTALL.md"), installMd, "utf8");
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to write pack files at ${target}: ${(err as Error).message}`,
            },
          ],
        };
      }

      const userGlobalHint = join(homedir(), ".claude", "skills", slug);
      return {
        content: [
          {
            type: "text",
            text:
              `Created environment pack "${name}" at:\n  ${target}\n\n` +
              `Files written:\n  - SKILL.md\n  - INSTALL.md\n\n` +
              `Tip: this pack is project-local. To make it available across all your projects, ` +
              `you can promote it to your user-global skills directory:\n  ${userGlobalHint}\n` +
              `(e.g. copy or move the folder there). Until then, Claude Code will only see it when working in this project.`,
          },
        ],
      };
    }
  );
}

export function createAiideMcpServer(opts: { workspaceDir?: string } = {}) {
  return createSdkMcpServer({
    name: "aiide",
    version: "1.0.0",
    tools: [
      openTabTool,
      addBookmarkTool,
      listBookmarksTool,
      deleteBookmarkTool,
      scanPortsTool,
      makeCreatePackTool(opts.workspaceDir),
    ],
  });
}
