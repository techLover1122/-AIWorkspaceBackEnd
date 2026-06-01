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
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
import { registerServicePort, type RegisteredService } from "../handlers/services.js";

function routerBaseForList(): string | null {
  const base = process.env.PROXY_ROUTER_URL;
  const uid = process.env.USER_ID;
  if (!base || !uid) return null;
  return `${base.replace(/\/+$/, "")}/api/services/${uid}`;
}

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

export const registerServiceTool = tool(
  "register_service",
  "Register a TCP port in this workspace as a public service. Returns the public domain URL the user's browser can reach. Use this BEFORE writing any code that the browser needs to fetch from a port other than the three defaults (3000=frontend, 8090=api, 8080=ide). Idempotent — calling twice with the same port returns the same URL. If you don't pass `name`, the subdomain becomes `port-<port>`.",
  {
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .describe("TCP port the service listens on inside the workspace."),
    name: z
      .string()
      .optional()
      .describe(
        "Optional subdomain segment (lowercase letters, digits, dashes; 1-32 chars). If omitted, defaults to `port-<port>`. Reserved: frontend, api, ide."
      ),
  },
  async ({ port, name }) => {
    const result = await registerServicePort(port, name);
    if (!result) {
      return {
        content: [
          {
            type: "text",
            text: `Could not register port ${port} — PROXY_ROUTER_URL or USER_ID is not set in this workspace, or the proxy router is unreachable. The user should check /etc/workspace.env and the workspace logs.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Registered port ${result.port} as "${result.name}" → ${result.url}. Routing is live within ~5s. Use this URL anywhere the browser fetches the service.`,
        },
      ],
    };
  }
);

/**
 * Read every SKILL.md under ~/.claude/skills/ and return its name +
 * description from the frontmatter. Used by list_environment_packs so the
 * model has a deterministic enumeration of what's installed instead of
 * relying on opaque skill auto-discovery.
 */
function readInstalledPacks(): Array<{
  slug: string;
  name: string;
  description: string;
  path: string;
}> {
  const skillsRoot = join(homedir(), ".claude", "skills");
  if (!existsSync(skillsRoot)) return [];

  const out: Array<{ slug: string; name: string; description: string; path: string }> = [];
  for (const slug of readdirSync(skillsRoot)) {
    const dir = join(skillsRoot, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMd = join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    let content = "";
    try {
      content = readFileSync(skillMd, "utf8");
    } catch {
      continue;
    }

    // Parse frontmatter: --- ... ---
    const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    let name = slug;
    let description = "(no description in frontmatter)";
    if (fm) {
      const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      const descMatch = fm[1].match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    out.push({ slug, name, description, path: dir });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export const listEnvironmentPacksTool = tool(
  "list_environment_packs",
  "List every environment pack installed at ~/.claude/skills/, with its name, slug, description, and path. Call this when the user's request is open-ended about tools/libraries (e.g. \"give me a database viewer\") and you'd otherwise pick on your own — packs encode the user's defaults for those cases. If the user explicitly named a tool, just do what they asked; you don't need to consult packs.",
  {},
  async () => {
    const packs = readInstalledPacks();
    if (packs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No environment packs installed at ~/.claude/skills/. The user has not pinned any tool/library choices, so you may pick reasonable defaults.",
          },
        ],
      };
    }
    const lines = packs.map(
      (p) =>
        `- **${p.name}** (${p.slug}) — ${p.description}\n    path: ${p.path}\n    Read its SKILL.md with the Skill tool, or directly with Read.`
    );
    return {
      content: [
        {
          type: "text",
          text: `Installed environment packs (${packs.length}):\n${lines.join(
            "\n"
          )}\n\nIf YOU are picking (the user left it open), default to the pack whose description matches. If the user explicitly asked for a specific tool, just do that — don't push the pack's choice.`,
        },
      ],
    };
  }
);

export const listServicesTool = tool(
  "list_services",
  "List all services currently registered for this workspace (the three defaults plus anything previously registered). Returns name, port, and public URL for each. Use this when the user asks what's running, or before registering to check if a port already has a name.",
  {},
  async () => {
    const base = routerBaseForList();
    if (!base) {
      return {
        content: [
          {
            type: "text",
            text: "Cannot list services — PROXY_ROUTER_URL or USER_ID is not set in this workspace.",
          },
        ],
      };
    }
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(`router returned ${res.status}`);
      const data = (await res.json()) as { services?: RegisteredService[] };
      const services = data.services ?? [];
      if (services.length === 0) {
        return {
          content: [{ type: "text", text: "No services registered." }],
        };
      }
      const lines = services.map(
        (s) => `- ${s.name} (port ${s.port}) → ${s.url}`
      );
      return {
        content: [
          { type: "text", text: `Registered services:\n${lines.join("\n")}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to list services: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
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

/* ─────────────── docs_* / sheets_* tools (office agents) ─────────────── */

/**
 * Loopback URLs of the two ONLYOFFICE-bridge sidecars cloud-init starts
 * (see ai-ide-docs-agent.service / ai-ide-sheets-agent.service). The
 * backend and the agents share the EC2, so direct 127.0.0.1 calls
 * skip the Traefik round-trip. Override via env if the agents ever
 * move off-box.
 */
const DOCS_AGENT_URL = process.env.DOCS_AGENT_URL ?? "http://localhost:4100";
const SHEETS_AGENT_URL =
  process.env.SHEETS_AGENT_URL ?? "http://localhost:4101";

/**
 * Forward a single { op, args } payload to the matching agent's /cmd
 * endpoint and return the agent's `result`. Throws if the agent reports
 * `ok=false` or HTTP-level failure — the tool wrappers turn that into
 * a `content: text` error so the model can recover.
 */
async function callAgent(
  kind: "docs" | "sheets",
  op: string,
  args: unknown
): Promise<unknown> {
  const url = kind === "docs" ? DOCS_AGENT_URL : SHEETS_AGENT_URL;
  const res = await fetch(`${url}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, args }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${kind}-agent /cmd failed: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  if (!data.ok) {
    throw new Error(data.error ?? `${kind}-agent returned ok=false`);
  }
  return data.result;
}

function asText(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fmtErr(prefix: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // The agent's most common failure mode is "no editor session
  // connected" — surface that distinctly so the model knows to ask the
  // user to open the document instead of retrying.
  if (msg.includes("no ") && msg.includes("editor session connected")) {
    return asText(
      `${prefix}: ${msg}. Ask the user to open the document in the workspace editor first.`
    );
  }
  return asText(`${prefix}: ${msg}`);
}

/* ─── sheets ops ─── */

export const sheetsSetValueTool = tool(
  "sheets_set_value",
  "Set the value of a single cell in the open XLSX spreadsheet via the sheets-agent. The user must have the sheet open at sheets-<USER_ID>.<PLATFORM_DOMAIN>. Accepts A1-style refs.",
  {
    cell: z
      .string()
      .describe("A1-style cell reference, e.g. 'A1', 'B12', 'Sheet2!C3'."),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "Value to set. Strings are written as text, numbers as numbers, booleans as booleans. For formulas use sheets_set_formula instead."
      ),
  },
  async ({ cell, value }) => {
    try {
      await callAgent("sheets", "sheets_set_value", { cell, value });
      return asText(`Set ${cell} = ${JSON.stringify(value)}.`);
    } catch (err) {
      return fmtErr(`Failed to set ${cell}`, err);
    }
  }
);

export const sheetsSetRangeTool = tool(
  "sheets_set_range",
  "Write a 2D block of values to a range in the open XLSX spreadsheet. The range and values dimensions must match (rows × cols). Use this instead of repeated sheets_set_value calls when populating multiple cells.",
  {
    range: z
      .string()
      .describe("A1-style range, e.g. 'A1:C3', 'Sheet1!B2:D5'."),
    values: z
      .array(
        z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      )
      .describe(
        "2D array of values, row-major. Outer length = number of rows, inner length = number of cols."
      ),
  },
  async ({ range, values }) => {
    try {
      await callAgent("sheets", "sheets_set_range", { range, values });
      const rows = values.length;
      const cols = values[0]?.length ?? 0;
      return asText(`Wrote ${rows}×${cols} block to ${range}.`);
    } catch (err) {
      return fmtErr(`Failed to write range ${range}`, err);
    }
  }
);

export const sheetsGetRangeTool = tool(
  "sheets_get_range",
  "Read the current value(s) of a cell or range from the open XLSX spreadsheet. Returns a single value for a single cell; for multi-cell ranges, returns a 2D array. Use this before sheets_set_range when you need to read-modify-write.",
  {
    range: z
      .string()
      .describe("A1-style cell or range, e.g. 'A1', 'A1:C3'."),
  },
  async ({ range }) => {
    try {
      const result = (await callAgent("sheets", "sheets_get_range", {
        range,
      })) as { value?: unknown };
      return asText(
        `Value at ${range}: ${JSON.stringify(result?.value ?? null)}`
      );
    } catch (err) {
      return fmtErr(`Failed to read ${range}`, err);
    }
  }
);

export const sheetsSetFormulaTool = tool(
  "sheets_set_formula",
  "Set a formula on a cell in the open XLSX spreadsheet. Pass the formula body WITHOUT the leading '=' — e.g. 'SUM(A1:A10)' not '=SUM(A1:A10)'.",
  {
    cell: z.string().describe("A1-style cell reference, e.g. 'D1'."),
    formula: z
      .string()
      .describe(
        "Formula body, e.g. 'SUM(A1:A10)', 'A1*B1', 'IF(A1>0,\"pos\",\"neg\")'. The leading '=' is added automatically."
      ),
  },
  async ({ cell, formula }) => {
    try {
      await callAgent("sheets", "sheets_set_formula", { cell, formula });
      return asText(`Set ${cell} = =${formula}`);
    } catch (err) {
      return fmtErr(`Failed to set formula on ${cell}`, err);
    }
  }
);

export const sheetsClearRangeTool = tool(
  "sheets_clear_range",
  "Clear the values + formulas in a range of the open XLSX spreadsheet, leaving formatting intact. Use sheets_set_range with explicit empty strings if you only want to overwrite without clearing formats.",
  {
    range: z
      .string()
      .describe("A1-style range to clear, e.g. 'A1:C10', 'Sheet1!B:B'."),
  },
  async ({ range }) => {
    try {
      await callAgent("sheets", "sheets_clear_range", { range });
      return asText(`Cleared ${range}.`);
    } catch (err) {
      return fmtErr(`Failed to clear ${range}`, err);
    }
  }
);

export const sheetsListSheetsTool = tool(
  "sheets_list_sheets",
  "Return the names of every tab in the currently-open XLSX workbook, in order. Use this before sheets_add_sheet if you need to avoid name collisions, or before targeted sheets_set_* calls on a specific sheet.",
  {},
  async () => {
    try {
      const result = (await callAgent("sheets", "sheets_list_sheets", {})) as {
        names?: string[];
      };
      const names = result?.names ?? [];
      if (names.length === 0) return asText("No sheets found.");
      return asText(`Sheets (${names.length}): ${names.join(", ")}`);
    } catch (err) {
      return fmtErr("Failed to list sheets", err);
    }
  }
);

export const sheetsAddSheetTool = tool(
  "sheets_add_sheet",
  "Add a new (empty) sheet tab to the open XLSX workbook with the given name. Fails if a sheet of that name already exists. Use sheets_list_sheets first if you need to check.",
  {
    name: z.string().describe("Name of the new sheet tab."),
  },
  async ({ name }) => {
    try {
      await callAgent("sheets", "sheets_add_sheet", { name });
      return asText(`Added sheet "${name}".`);
    } catch (err) {
      return fmtErr(`Failed to add sheet "${name}"`, err);
    }
  }
);

/* ─── docs ops ─── */

export const docsGetTextTool = tool(
  "docs_get_text",
  "Return the full plain-text content of the open DOCX document. Use this as the read step before docs_insert_text or docs_replace_text so you can see what's already there.",
  {},
  async () => {
    try {
      const result = (await callAgent("docs", "docs_get_text", {})) as {
        text?: string;
      };
      const text = result?.text ?? "";
      if (!text) return asText("Document is empty.");
      return asText(`Document text (${text.length} chars):\n\n${text}`);
    } catch (err) {
      return fmtErr("Failed to read document text", err);
    }
  }
);

export const docsInsertTextTool = tool(
  "docs_insert_text",
  "Append plain text to the end of the open DOCX document. For replacing existing text use docs_replace_text; for inserting at a specific location, ask the user to place the cursor first then use docs_replace_text against a known marker.",
  {
    text: z
      .string()
      .describe("Text to append. Use '\\n' for line breaks within a paragraph."),
  },
  async ({ text }) => {
    try {
      await callAgent("docs", "docs_insert_text", { text });
      return asText(`Appended ${text.length} chars to document.`);
    } catch (err) {
      return fmtErr("Failed to insert text", err);
    }
  }
);

export const docsReplaceTextTool = tool(
  "docs_replace_text",
  "Find every occurrence of `find` in the open DOCX document and replace with `replace`. Returns how many replacements were made. Case-insensitive unless matchCase is true.",
  {
    find: z.string().describe("Text to search for (must be non-empty)."),
    replace: z.string().describe("Replacement text. Pass '' to delete matches."),
    matchCase: z
      .boolean()
      .optional()
      .describe("If true, match exactly. Default false (case-insensitive)."),
  },
  async ({ find, replace, matchCase }) => {
    try {
      await callAgent("docs", "docs_replace_text", { find, replace, matchCase });
      return asText(
        `Replaced "${find}" → "${replace}" in document${
          matchCase ? " (case-sensitive)" : ""
        }.`
      );
    } catch (err) {
      return fmtErr("Failed to replace text", err);
    }
  }
);

export const docsApplyHeadingTool = tool(
  "docs_apply_heading",
  "Apply a heading style (Heading 1-6) to the user's current selection in the open DOCX document. Requires the user to have made a selection — call docs_get_text first if you need to see what's there.",
  {
    level: z
      .number()
      .int()
      .min(1)
      .max(6)
      .describe("Heading level, 1-6."),
  },
  async ({ level }) => {
    try {
      await callAgent("docs", "docs_apply_heading", { level });
      return asText(`Applied Heading ${level} to current selection.`);
    } catch (err) {
      return fmtErr(`Failed to apply Heading ${level}`, err);
    }
  }
);

export function createAiideMcpServer(opts: { workspaceDir?: string } = {}) {
  return createSdkMcpServer({
    name: "aiide",
    version: "1.0.0",
    tools: [
      openTabTool,
      registerServiceTool,
      listServicesTool,
      listEnvironmentPacksTool,
      addBookmarkTool,
      listBookmarksTool,
      deleteBookmarkTool,
      scanPortsTool,
      makeCreatePackTool(opts.workspaceDir),
      // Office agent bridges (Phase 6) — see callAgent + agent.ts.
      sheetsSetValueTool,
      sheetsSetRangeTool,
      sheetsGetRangeTool,
      sheetsSetFormulaTool,
      sheetsClearRangeTool,
      sheetsListSheetsTool,
      sheetsAddSheetTool,
      docsGetTextTool,
      docsInsertTextTool,
      docsReplaceTextTool,
      docsApplyHeadingTool,
    ],
  });
}
