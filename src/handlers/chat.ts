import { Context } from "hono";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatRequest } from "../types.js";
import { info, warn, error as logError } from "../utils/logger.js";
import { recordSession } from "../utils/db.js";
import { createAiideMcpServer } from "../mcp/aiideTools.js";
import {
  createTask,
  pushEvent,
  setTaskSessionId,
  setTaskStatus,
  setTaskAbsentMode,
  setTaskCapturedIntent,
  abortTask as abortTaskInRegistry,
  getTask,
} from "../utils/taskRegistry.js";
import {
  createPendingPermission,
  denyPending,
  autoAllowPending,
  type PermissionRequestPayload,
} from "./permission.js";
import { runIntentGuard, denyIntentGuard } from "../middleware/intentGuardAgent.js";
import { assessTool, createSessionHistory, recordApproval } from "../middleware/toolGuardAgent.js";
import { runAnomalyDetection, type ExecutedAction } from "../middleware/anomalyDetectionAgent.js";
import {
  notifyTaskDone,
  notifyPermission,
  notifyAskUserQuestion,
  rememberSession,
  shouldNotifyWhatsApp,
  scheduleDeferredNotify,
  cancelDeferredNotify,
  cancelDeferredNotifyForSession,
  isWhatsAppLinked,
} from "../utils/whatsappBridge.js";

/**
 * How long canUseTool waits on a user permission decision before
 * auto-allowing and switching the task to "absent mode" (every
 * subsequent canUseTool in this task auto-allows without waiting).
 *
 * The user explicitly requested this: long unattended runs (e.g. E2E
 * testing flows) shouldn't stall on every tool prompt if they've stepped
 * away. They'd rather have the task complete autonomously than have it
 * pause forever waiting on a click.
 *
 * Trade-off: this WILL run tools without a real consent if the user is
 * gone for 5+ minutes. Acceptable because:
 *   - The user opted into this behavior knowingly.
 *   - They can still Stop the task via the abort button.
 *   - Real destructive tools (rm -rf etc.) are still gated by the SDK's
 *     own deny rules — the canUseTool ask only fires for tools the SDK
 *     considers borderline.
 *   - bypassPermissions mode (set upfront via the chat header chip)
 *     already skips canUseTool entirely; absent-mode is the on-demand
 *     equivalent for partial-attended sessions.
 */
const PERMISSION_WAIT_MS = 5 * 60 * 1000;

// MCP tool names must be prefixed with `mcp__<server>__` in allowedTools.
const MCP_TOOL_NAMES = [
  "mcp__aiide__open_tab",
  "mcp__aiide__register_service",
  "mcp__aiide__list_services",
  "mcp__aiide__list_environment_packs",
  "mcp__aiide__add_bookmark",
  "mcp__aiide__list_bookmarks",
  "mcp__aiide__delete_bookmark",
  "mcp__aiide__scan_ports",
  "mcp__aiide__create_pack",
];

// Phase 4 — Playwright MCP wired through to the desktop app.
//
// Points at the reverse-SSH-tunneled `http://127.0.0.1:9090/` on this
// EC2 (the desktop's Electron app provides the upstream end and auto-
// manages the tunnel). The default is the tunnel address — set
// PLAYWRIGHT_MCP_URL to an explicit value to override, or to "" / "off"
// to disable the integration entirely. The SDK tolerates an unreachable
// MCP URL at session start, so a dead tunnel doesn't block chat —
// playwright tool calls just fail until the tunnel is back.
const _rawMcpUrl = process.env.PLAYWRIGHT_MCP_URL;
const PLAYWRIGHT_MCP_URL =
  _rawMcpUrl === undefined
    ? "http://127.0.0.1:9090/"
    : _rawMcpUrl === "" || _rawMcpUrl.toLowerCase() === "off"
      ? null
      : _rawMcpUrl;
const PLAYWRIGHT_TOOL_NAMES = PLAYWRIGHT_MCP_URL ? [
  // core — page interaction primitives
  "mcp__desktopbrowser__browser_snapshot",
  "mcp__desktopbrowser__browser_click",
  "mcp__desktopbrowser__browser_drag",
  "mcp__desktopbrowser__browser_hover",
  "mcp__desktopbrowser__browser_select_option",
  "mcp__desktopbrowser__browser_type",
  "mcp__desktopbrowser__browser_press_key",
  "mcp__desktopbrowser__browser_handle_dialog",
  "mcp__desktopbrowser__browser_take_screenshot",
  "mcp__desktopbrowser__browser_file_upload",
  "mcp__desktopbrowser__browser_close",
  "mcp__desktopbrowser__browser_resize",
  "mcp__desktopbrowser__browser_wait_for",
  "mcp__desktopbrowser__browser_evaluate",
  // browser_navigate is intentionally NOT exposed: the model kept using it to
  // replace the user's current tab when asked to "go to <site>", wiping out
  // their workspace. To open a site, use mcp__aiide__open_tab (new tab).
  // browser_navigate_back stays for going back within a tab.
  "mcp__desktopbrowser__browser_navigate_back",
  "mcp__desktopbrowser__browser_console_messages",
  "mcp__desktopbrowser__browser_network_requests",
  // core-tabs
  "mcp__desktopbrowser__browser_tabs",
  // vision — coordinate-based interactions
  "mcp__desktopbrowser__browser_mouse_click_xy",
  "mcp__desktopbrowser__browser_mouse_drag_xy",
  "mcp__desktopbrowser__browser_mouse_move_xy",
  // pdf
  "mcp__desktopbrowser__browser_pdf_save",
  // network
  "mcp__desktopbrowser__browser_network_capture",
  // devtools
  "mcp__desktopbrowser__browser_devtools_console",
] : [];

/**
 * Workspace-environment context appended to every chat request's system
 * prompt. Without this the model treats the box as a normal Linux VM and
 * writes code with `http://localhost:<port>` URLs — which the user's
 * browser can't reach, since it's on a different origin (the edge proxy).
 *
 * Filled at request time from env so it reflects this specific workspace.
 */
/**
 * The chat panel's most-load-bearing Phase 6 context.
 *
 * The `mcp__desktopbrowser__*` tools (browser_tabs / browser_snapshot /
 * browser_click / etc.) connect via a reverse SSH tunnel to a Playwright
 * MCP server running inside the user's desktop app. That MCP server
 * drives the user's actual WebContentsView tabs over CDP — the same tabs
 * the user sees in their workspace right now. NOT a sandboxed Chromium,
 * NOT a Docker container.
 *
 * The other Playwright context (buildPlaywrightContext) talks about the
 * Docker container with playwright-test for writing/running spec files.
 * Two completely different surfaces; the model has historically conflated
 * them because the tools all start with `browser_`. This context is the
 * disambiguation.
 *
 * Only inserted when PLAYWRIGHT_MCP_URL is set (the tunnel is live).
 */
function buildDesktopBrowserContext(): string {
  return [
    "# Desktop browser control — mcp__desktopbrowser__ tools drive REAL user tabs",
    "",
    "## ABSOLUTE RULE — read this first",
    "",
    "For ANY request to look at or act on a web page / browser / tab — read,",
    "scroll, click, type, navigate, screenshot, snapshot, fill a form, check a",
    "site, \"see what's on my screen\" — you MUST use the `mcp__desktopbrowser__browser_*`",
    "tools. They ARE the user's real, visible browser. This is non-negotiable.",
    "",
    "For acting on the user's pages you must NEVER:",
    "- write or run a Playwright `.spec.ts` file,",
    "- run `docker exec ai-ide-playwright ...` or any headless Chromium,",
    "- call your browser access \"headless\", \"sandboxed\", \"server-side\", \"a",
    "  separate instance\", or say you \"can't see the user's actual browser\".",
    "Those statements are FALSE here and the headless Docker Playwright is ONLY",
    "for when the user EXPLICITLY asks you to write or run automated tests — never",
    "for interacting with their live tabs. If you catch yourself reaching for a",
    "script or Docker to view/act on a page, STOP and use the mcp__desktopbrowser__",
    "tools instead.",
    "",
    "## Opening sites — NEVER replace the user's current tab",
    "",
    "When the user asks to OPEN / GO TO / NAVIGATE TO a site by name or URL",
    "(e.g. \"go to linkedin\", \"open google\", \"pull up X\"), you MUST open it in a",
    "NEW tab with `mcp__aiide__open_tab` (args: url, optional label). That adds a",
    "fresh tab to the user's workspace WITHOUT touching what they were looking at.",
    "",
    "There is deliberately NO tool to point the user's current tab at a new URL",
    "(`browser_navigate` is not available to you) — precisely so you can't wipe",
    "out what they were viewing. Opening a site = a new tab via open_tab, full",
    "stop. To move within a tab use links on the page (`browser_click`) or",
    "`browser_navigate_back` to go back. `browser_tabs` action \"new\" also does",
    "NOT work (Electron can't create tabs over CDP). open_tab is the ONLY way to",
    "open a tab; don't claim you opened one unless you used it.",
    "",
    "## CRITICAL: which Playwright is this?",
    "",
    "When `mcp__desktopbrowser__browser_*` tools are available (they are right",
    "now — that's why this section is in your context), they are connected",
    "to the **user's actual desktop app**, NOT a sandbox.",
    "",
    "Concretely: there is an Electron app on the user's machine right now",
    "called \"AI IDE Studio\" running this same workspace. Every tab the user",
    "has open in their workspace is a real Chromium top-level page target,",
    "addressable via the Playwright MCP server. When you call:",
    "",
    "- `browser_tabs list` → you get the user's real tab list (their VS Code,",
    "  Odoo, gym site, code-server, etc.) — same one they see in the strip.",
    "- `browser_tabs select index=N` → you switch Playwright's \"current",
    "  page\" to the user's Nth tab.",
    "- `browser_snapshot` → ARIA snapshot of THAT user's tab at this moment.",
    "- `browser_click` / `browser_type` / `browser_press_key` → real",
    "  interactions on the user's tab. The user SEES this happen.",
    "- `browser_take_screenshot` → PNG of the user's tab content.",
    "",
    "## ❌ DO NOT say things like:",
    "",
    "- \"I can't access your real browser, Playwright runs in a sandbox.\"",
    "- \"I'd have to open a new tab in a Docker container.\"",
    "- \"I can only screenshot a sandboxed Chromium, not your real session.\"",
    "",
    "These are FALSE. When you say them, the user thinks the integration is",
    "broken. It's not — these tools drive their actual session. Past chat",
    "turns have correctly used these tools to fill forms and click buttons",
    "in the user's real workspace; the tool surface has not changed.",
    "",
    "## ✅ What to do instead",
    "",
    "When the user says \"do X on the Y tab\" (e.g. \"complete the trainee",
    "registration on the gym site\"):",
    "",
    "1. `browser_tabs list` — confirm the tab is there. If not, open it via",
    "   `mcp__aiide__open_tab` (which adds it to the user's real workspace).",
    "2. `browser_tabs select index=<that-tab>` — make it Playwright's current.",
    "3. `browser_snapshot` — read the page's ARIA tree. Identify the form",
    "   fields by their `[ref=eXX]` references.",
    "4. `browser_type` / `browser_select_option` / `browser_click` against",
    "   those refs to fill and submit the form.",
    "5. `browser_snapshot` again or `browser_take_screenshot` to verify the",
    "   result.",
    "",
    "If a form needs real personal data (name, email, phone) and the user",
    "didn't supply it, ask them — but ask with the expectation that you",
    "WILL fill the form once they answer, not with an apology that you",
    "can't.",
    "",
    "## Relationship to the other Playwright section below",
    "",
    "The next section (E2E testing with `ai-ide-playwright`) is about",
    "writing `.spec.ts` files and running them in a Docker container with",
    "headless Chromium — for verifying YOUR code changes via automated",
    "tests. That container has nothing to do with the user's browser tabs.",
    "",
    "Rule of thumb:",
    "- User says \"act on my tab\" / \"go to X\" / \"click Y\" / \"fill the form on Z\"",
    "  → `mcp__desktopbrowser__browser_*` (this section).",
    "- User says \"write me an E2E test\" / \"verify my login feature works\"",
    "  → `docker exec ai-ide-playwright npx playwright test` (next section).",
    "",
    "Both can coexist. Don't conflate them.",
  ].join("\n");
}

function buildProxyContext(): string | null {
  const userId = process.env.USER_ID;
  const domain = process.env.PLATFORM_DOMAIN;
  if (!userId || !domain) return null;

  const scheme = (process.env.PLATFORM_PROTOCOL || "http").toLowerCase();
  const base = (name: string) => `${scheme}://${name}-${userId}.${domain}`;
  return [
    "# Workspace environment",
    "",
    "This workspace runs behind an edge proxy + per-user Traefik. Every HTTP",
    "service exposed here is reachable from the user's browser ONLY through a",
    "public subdomain — `http://localhost:<port>` URLs are NOT reachable from",
    "the browser (the user is on a different origin).",
    "",
    "## Default service URLs",
    "",
    `- Frontend (Next.js, port 3000):  ${base("frontend")}`,
    `- Backend API (Hono, port 8090):  ${base("api")}`,
    `- code-server / IDE (port 8080):  ${base("ide")}`,
    "",
    "## Adding a new service",
    "",
    "When you start any new HTTP service in this workspace (a dev server, an",
    "API, a Storybook, anything):",
    "",
    "1. Bind it to localhost or 0.0.0.0 on any unprivileged port — the port",
    "   itself doesn't matter.",
    "2. Register the port using the `register_service` MCP tool, e.g.",
    "   `register_service(port=5173)`. The tool returns the public URL.",
    "3. Use that URL — NOT `http://localhost:5173` — wherever the browser",
    "   needs to reach the service (fetch calls, iframe src, links, etc.).",
    "",
    "If you skip step 2, the user's browser will get DNS / CORS errors when",
    "your code tries to fetch the new service.",
    "",
    `## Auto-generated subdomain convention\n\nAny port \`P\` registered without an explicit name becomes\n  \`http://port-P-${userId}.${domain}\`\n`,
    "## CORS",
    "",
    `The browser's origin is \`${base("frontend")}\`. Any backend service`,
    "that needs to receive cross-origin XHR from the frontend must send",
    "CORS headers permitting that origin (or `*`). The default backend at",
    `\`${base("api")}\` already does this.`,
    "",
    "## Don't",
    "",
    "- Don't hardcode `localhost` or `127.0.0.1` URLs in browser-facing code.",
    "- Don't write Vite/Webpack dev-server configs that print",
    "  `http://localhost:<port>` as the dev URL — the user will copy-paste it",
    "  and get a CORS / DNS error. Either reconfigure them to print the",
    "  registered public URL, or remind the user of the public URL after",
    "  registering.",
    "- Don't try to bind privileged ports (<1024). Port 80 is owned by",
    "  Traefik; don't fight it.",
    "",
    "# Chat output: links",
    "",
    "Links you write in your chat replies do NOT render as plain `<a>` tags —",
    "they're rendered as inline pill-buttons that open the URL as a new",
    "workspace tab (same path as the `open_tab` MCP tool, just user-initiated).",
    "",
    "Implications for how you write:",
    "",
    "- Always write a URL as a markdown link with a SHORT descriptive label:",
    "  `[Open the dashboard](http://frontend-...)` — never paste raw URLs in",
    "  prose. The label becomes the button text.",
    "- Don't tell the user \"navigate to ...\" or \"open ... in your browser\".",
    "  Just give them the link button. One click does the right thing.",
    "- Code blocks (\\`url\\`) are still inline code; only actual markdown",
    "  links become buttons. Use code formatting for URLs the user needs to",
    "  copy/edit, link formatting for URLs they should open.",
    "- After registering a service, surface the public URL as a link button",
    "  so the user gets a one-click open:",
    "  `Done — [open my-app](http://my-app-USER.DOMAIN)`.",
    "",
    "# Iframe compatibility",
    "",
    "Every service exposed through the workspace is rendered inside an",
    "iframe in the user's AI-IDE UI. Anything you build MUST be embeddable",
    "or the user will get a blank tab.",
    "",
    "## Rule: don't block framing",
    "",
    "- Do NOT set `X-Frame-Options: DENY` or `SAMEORIGIN`. If a framework",
    "  sets it by default (Next.js prior to v14, Helmet, Spring Security,",
    "  Django's middleware), remove or override it.",
    "- Do NOT set a `Content-Security-Policy` with `frame-ancestors 'none'`",
    "  or `frame-ancestors 'self'`. Either omit `frame-ancestors` or set it",
    `  to \`frame-ancestors *\` (or specifically the frontend origin).`,
    "- Do NOT call `if (window.top !== window.self) window.top.location = …`",
    "  or any other \"frame-buster\" — they break the workspace.",
    "",
    "## Rule: cookies must work cross-origin",
    "",
    "The iframe's URL (`<service>-<userId>.<domain>`) is a different origin",
    "from the parent frontend. Cookies the iframe sets/receives must be:",
    "",
    "- `SameSite=None; Secure` — required for any cookie sent in a third-",
    "  party context (which an iframe is). Plain `SameSite=Lax` cookies",
    "  silently get dropped.",
    "- HTTPS-only once TLS is on (it is). `Secure` is mandatory with",
    "  `SameSite=None`.",
    "",
    "## Rule: auth flows can't full-page-redirect",
    "",
    "OAuth / SSO providers that redirect to `top.location` (or refuse to",
    "load themselves in an iframe) will break inside the workspace. When",
    "scaffolding auth, prefer:",
    "",
    "1. Backend-handled OAuth (the OAuth provider redirects to your",
    "   backend, which sets the cookie and 302s to your app — all in the",
    "   iframe), or",
    "2. Popup-based auth flow (open a new window for the redirect, post",
    "   the token back via `postMessage`).",
    "",
    "Tell the user explicitly if a chosen auth provider refuses iframe",
    "embedding (Google's OAuth screen does, Auth0's does too by default).",
    "",
    "# Environment packs (installed skills)",
    "",
    "This workspace has user-installed environment packs at `~/.claude/skills/`.",
    "Each pack's `SKILL.md` documents specific tool / library / config choices",
    "the user previously settled on for this environment. Packs are advisory",
    "*defaults* for cases where the user hasn't specified — they DO NOT",
    "override an explicit user instruction.",
    "",
    "## Rule: when YOU are choosing, consult packs first",
    "",
    "When the user's request is **open-ended** about tools — e.g. \"give me a",
    "database viewer\", \"add a chart library\", \"set up an auth flow\" — and",
    "you would otherwise pick something on your own, do this FIRST:",
    "",
    "1. Call `list_environment_packs`.",
    "2. Read any pack whose description plausibly covers the request.",
    "3. If a pack covers it, follow that pack verbatim — install / configure",
    "   exactly what it says. Don't substitute a tool you happen to know",
    "   better.",
    "",
    "If you genuinely think the pack's choice is wrong for this case, tell",
    "the user before deviating:",
    "",
    "  > The <pack-name> pack specifies <X>, but I'd like to use <Y> here",
    "  > because <reason>. OK to deviate from the pack?",
    "",
    "Then wait for their answer.",
    "",
    "## Rule: when the USER chooses, defer to the user (no pushback)",
    "",
    "If the user **explicitly** asks for a specific tool / library — e.g.",
    "\"install pgweb\", \"use Adminer\", \"add Tailwind v4\" — just do it. Do",
    "not say \"the pack specifies X instead\". The user knows. This is often",
    "how they evolve their packs in the first place: they try something off-",
    "pack, decide it works, and bake it into the next pack revision.",
    "",
    "The most you should do is mention the conflict once, briefly, AFTER",
    "completing the task — e.g. \"Installed pgweb. Heads-up: the <pack> pack",
    "has Mathesar as the default DB viewer; let me know if you'd like to",
    "update the pack.\" Then drop it.",
    "",
    "## Rule: cross-session memory",
    "",
    "When YOU are picking (not the user), packs are project-level decisions",
    "that span sessions. A new session asking \"give me a database viewer\"",
    "should still produce Mathesar if that's what the pack says — even if",
    "the previous session is gone. Re-list the packs.",
  ].join("\n");
}

/**
 * Completion-verification context — the broad "auto-test before declaring
 * done" rule. Whatever Claude does (write code, refactor, fix a bug, add
 * a feature), it MUST run the project's verification suite (type-check,
 * lint, unit tests, build) and fix any failures before telling the user
 * "done". This catches the most common AI-assist failure mode where a
 * model "completes" a task that doesn't actually compile or pass tests.
 *
 * Sits BEFORE the Playwright section in the appendedSystem array because
 * the broader checks should run first — type errors mean the E2E test
 * would fail anyway, and we want clear sequential signal.
 */
function buildCompletionVerificationContext(): string {
  return [
    "# Completion verification — auto-test EVERY prompt before declaring \"done\"",
    "",
    "## ⛔ HARD RULE — read this every turn",
    "",
    "The user has explicitly said, more than once, that the chat panel is",
    "shipping turns without running tests. They consider this a broken",
    "promise. So this rule is now a CONTRACT, not a guideline.",
    "",
    "Before EVERY message that signals completion — anything containing",
    "\"done\", \"complete\", \"finished\", \"ready\", \"all set\", \"here you go\",",
    "\"I've added/fixed/built X\", or any equivalent — you MUST be able to",
    "answer YES to ALL of these:",
    "",
    "1. **Did I actually RUN the verification suite for the touched project**",
    "   (type-check, lint, unit tests, build, as applicable per the matrix",
    "   below)? Not \"could run\", not \"would run\" — actually ran it this",
    "   turn, against the live code, with output you can quote?",
    "",
    "2. **If the change has a user-visible surface** — a page, form, button,",
    "   route, anything the user would click — **did I run a Playwright E2E**",
    "   test that actually drives it? (See the next section for how.)",
    "",
    "3. **Did at least one assertion in those checks return GREEN**? Not",
    "   \"started successfully\", not \"looks like it should pass\" — actually",
    "   green, with the literal pass-line in your reply so the user can see",
    "   you ran it (e.g. `1 passed (3.2s)`, `tsc — clean`, `build complete`).",
    "",
    "4. **Am I about to claim \"tests pass\" without quoting the runner's",
    "   actual output**? If yes — STOP. Quote the output, or don't claim it.",
    "",
    "If ANY answer is no → STOP. Do the verification now. Don't promise",
    "to test \"on the next turn\" — test THIS turn. Re-run until green.",
    "",
    "This rule overrides every \"reasonable shortcut\". It is stronger than:",
    "- \"the user seems in a hurry\"",
    "- \"the change is trivial / cosmetic / one-liner\"",
    "- \"I'm pretty sure it works, I've done this pattern before\"",
    "- \"this is just a config tweak\" (those break builds CONSTANTLY)",
    "- \"I'll batch the tests at the end\"",
    "",
    "Skipping this and saying \"done\" anyway is lying to the user. They've",
    "told us they read this section before trusting any \"done\". The skip",
    "rules below are the ONLY exit clauses — nothing else qualifies.",
    "",
    "## Default rule (not opt-in)",
    "",
    "Run the project's full verification suite. If anything fails, fix",
    "the root cause and re-run until clean. ONLY THEN tell the user.",
    "",
    "Do this even when the user did NOT ask for tests — verification on",
    "completion is the default behavior of this workspace. Stops the most",
    "common failure mode: \"AI says done, code doesn't actually compile\".",
    "",
    "## Step 1 — identify the project type",
    "",
    "Look at the project's manifest files in the working directory:",
    "",
    "| File found             | Project type |",
    "| ---------------------- | ------------ |",
    "| `package.json`         | Node / TypeScript / JavaScript |",
    "| `pyproject.toml`       | Python (modern) |",
    "| `requirements.txt`     | Python (legacy) |",
    "| `Cargo.toml`           | Rust |",
    "| `go.mod`               | Go |",
    "| `__manifest__.py`      | Odoo addon |",
    "| `composer.json`        | PHP |",
    "",
    "## Step 2 — run checks IN ORDER",
    "",
    "Stop at the first failure, fix, then resume from where you stopped.",
    "Don't run all checks in parallel — sequential gives clearer signal.",
    "",
    "### Node / TypeScript",
    "",
    "```bash",
    "# Always run in the project's directory",
    "cd <project-dir>",
    "",
    "# 1. Type check (fastest, catches the most bugs)",
    "[ -f tsconfig.json ] && npx tsc --noEmit",
    "",
    "# 2. Lint (style + simple bugs)",
    "[ -f .eslintrc.json ] || [ -f .eslintrc.js ] || [ -f eslint.config.js ] \\",
    "  && npx eslint . --max-warnings 0",
    "",
    "# 3. Unit tests (if a test script exists in package.json)",
    "npm pkg get scripts.test 2>/dev/null | grep -v '\"\"' \\",
    "  && npm test --silent",
    "",
    "# 4. Build (catches things type-check misses — bundler / loader errors)",
    "npm pkg get scripts.build 2>/dev/null | grep -v '\"\"' \\",
    "  && npm run build",
    "```",
    "",
    "### Python",
    "",
    "```bash",
    "cd <project-dir>",
    "",
    "# 1. Type check (if mypy or pyright config exists)",
    "[ -f mypy.ini ] || grep -q '\\[tool.mypy\\]' pyproject.toml 2>/dev/null \\",
    "  && python -m mypy .",
    "",
    "# 2. Lint",
    "command -v ruff && ruff check .",
    "",
    "# 3. Tests",
    "[ -d tests ] || [ -d test ] && pytest -q",
    "```",
    "",
    "### Rust",
    "```bash",
    "cargo check && cargo clippy -- -D warnings && cargo test --no-fail-fast",
    "```",
    "",
    "### Odoo addon",
    "```bash",
    "# Smoke-test by installing/upgrading the module — catches manifest,",
    "# import, and XML view errors that nothing else does.",
    "docker exec ai-ide-playwright /work/odoo19/odoo-bin \\",
    "  -d <db> -u <module> --stop-after-init --no-http",
    "# (Or use the user's existing tmux odoo session and `--dev=all`.)",
    "```",
    "",
    "### Go",
    "```bash",
    "go vet ./... && go test ./...",
    "```",
    "",
    "## Step 3 — handle failures",
    "",
    "On ANY non-zero exit:",
    "",
    "1. Read the error message — the actual error, not just the summary.",
    "2. Find the root cause in the code. Don't suppress (`// @ts-ignore`,",
    "   `# type: ignore`, `eslint-disable`) unless the rule itself is wrong",
    "   and the user agrees.",
    "3. Apply the fix to the source.",
    "4. Re-run the SAME check that failed.",
    "5. If still failing after 5 attempts on the same error, STOP and ask",
    "   the user — don't keep flailing.",
    "",
    "## Step 4 — RUN E2E (this step is mandatory, not optional)",
    "",
    "If the change is user-visible OR the turn installed/started any service",
    "with a web UI (new page, form, button, layout, service like n8n /",
    "mailhog / postgres-admin / etc.), RUN PLAYWRIGHT. See the dedicated",
    "E2E section earlier in this prompt — it has the full checklist the",
    "user requires before you say \"done\". This is not a \"nice to have\";",
    "the user has explicitly called out skipped E2E as a trust break.",
    "",
    "Saying \"the code compiles\" is not a substitute for saying \"the page",
    "renders\". Run the test.",
    "",
    "## Step 5 — report what you ran",
    "",
    "When telling the user you're done, list exactly what passed:",
    "",
    "> Built the login form. Verified:",
    "> ✓ tsc clean (0 errors)",
    "> ✓ eslint clean (0 warnings)",
    "> ✓ 12/12 unit tests pass",
    "> ✓ npm run build succeeds (1.2 MB bundle)",
    "> ✓ Playwright E2E: login.spec.ts passes (2.4s, Chromium)",
    "",
    "Specific numbers > vague \"everything looks good\". The user should",
    "be able to trust the report without re-running the checks themselves.",
    "",
    "## When to SKIP this rule",
    "",
    "- Pure config / doc edits (no compile target)",
    "- One-shot scripts the user runs once (no project context)",
    "- User explicitly says \"don't test\" / \"just code\" / \"skip verification\"",
    "- The project has no recognized manifest (rare — pretty much only",
    "  raw script directories)",
    "- Working in a read-only inspection mode (no code changes)",
    "",
    "## Don't lie about results",
    "",
    "If a check timed out or you couldn't reach the runner, SAY THAT.",
    "Don't say \"all checks passed\" when you didn't actually run them.",
    "Don't say \"build succeeds\" if you only got past the type check.",
    "The user trusts your report — keep that trust by being accurate.",
    "",
    "Concrete failure-honesty examples:",
    "- Bad:  \"All tests pass, everything looks good!\"  (when you didn't",
    "        actually run them because the test command hung)",
    "- Good: \"tsc clean, eslint clean. Tests took >2 min and I aborted —",
    "        please run `npm test` locally to verify the 3 changed specs.\"",
  ].join("\n");
}

/**
 * Persistent-memory context. The user asked that the chat panel maintain
 * its OWN memory automatically — recall it at the start of a turn and
 * save/update it at the end of EVERY turn, with the same discipline the
 * E2E rule applies to testing — so they never have to repeat a preference,
 * decision, or fact they've already given.
 *
 * The store is Claude Code's NATIVE user-memory file, ~/.claude/CLAUDE.md.
 * It is auto-loaded into context at the start of every session (so recall
 * is automatic and reliable) and is the file the agent already edits via
 * its built-in memory affordance. We deliberately use this one canonical
 * file — visible and editable in one place — instead of a parallel store
 * the model tends to ignore in favor of CLAUDE.md.
 */
function buildMemoryContext(): string {
  return [
    "# Persistent memory — recall + UPDATE every turn (a CONTRACT, like E2E)",
    "",
    "## ⛔ HARD RULE — read this every turn",
    "",
    "The user asked you to keep your OWN memory, the same way you run E2E",
    "after every prompt: recall what you already know, and save/update it",
    "at the end of EVERY turn. The whole point is that they NEVER have to",
    "tell you the same thing twice — a preference, a decision, a name, a",
    "path, a correction. Forgetting something they already told you is the",
    "same kind of trust-break as skipping E2E.",
    "",
    "Do this silently. Don't narrate it or ask permission to remember —",
    "at most ONE short line when you persist something material (e.g.",
    "\"(noted: you prefer pnpm)\"). Never turn it into a conversation.",
    "",
    "A spoken \"Noted!\" / \"I'll keep that in mind\" is NOT memory. If you",
    "acknowledge a durable fact, you MUST also WRITE it to",
    "`~/.claude/CLAUDE.md` in the SAME turn — replying without writing is the",
    "trust-break. \"Just note it\" / \"nothing else needed\" does NOT mean skip",
    "saving; writing the file IS the note. The only time you may skip writing",
    "is when the fact is already in CLAUDE.md or is genuinely transient.",
    "",
    "## Where memory lives",
    "",
    "Your memory is the file **`~/.claude/CLAUDE.md`** — Claude Code's native",
    "user memory. It is AUTO-LOADED into your context at the start of every",
    "session, so anything saved there you already know next time. This is the",
    "single source of truth for cross-session memory — do NOT invent a",
    "parallel store (no `~/.ai-ide/memory/`, no scratch files); everything",
    "goes in this one file so the user has exactly one place to look.",
    "",
    "## Step 1 — RECALL (start of every turn, before you act)",
    "",
    "`~/.claude/CLAUDE.md` is already in your context — honor it. If it says",
    "the user prefers pnpm, use pnpm without asking; if it records a project",
    "decision, follow it. A saved fact reflects what was true when written —",
    "if it names a file/flag/path, sanity-check it still exists before",
    "relying on it. (If for some reason it is NOT in context, run",
    "`cat ~/.claude/CLAUDE.md` before acting.)",
    "",
    "## Step 2 — CAPTURE / UPDATE (end of every turn, before \"done\")",
    "",
    "Before wrapping up, ask: did this turn reveal anything DURABLE a future",
    "session would need and couldn't re-derive? If yes, write it into",
    "`~/.claude/CLAUDE.md` (use your memory tool, or Edit the file directly).",
    "Capture:",
    "",
    "- **preferences** — tools, stack, style, workflow, how they want you to",
    "  behave (\"always pnpm\", \"don't add comments\", \"deploy via X\").",
    "- **project facts** — goals, constraints, decisions, current state /",
    "  next-up that are NOT obvious from the code or git history. Convert",
    "  relative dates to absolute (\"today\" → the actual date).",
    "- **corrections** — anything the user pushed back on, plus the why, so",
    "  you don't repeat the mistake.",
    "- **references** — URLs, dashboards, ticket IDs, and where credentials",
    "  live (never the secret value itself).",
    "",
    "Organize entries under clear `##` headings. UPDATE the matching section",
    "instead of appending a near-duplicate; DELETE an entry that turns out",
    "wrong (stale memory is worse than none). Keep entries tight.",
    "",
    "## Don't save",
    "",
    "- Things derivable from the repo (code structure, what a function does,",
    "  git history) — re-read the source instead.",
    "- Secret VALUES (tokens, passwords, keys). Record where they live, not",
    "  what they are.",
    "- One-off details that only matter to the current turn.",
    "",
    "If the user says \"remember that …\" — persist it immediately. If they",
    "say \"forget …\" — delete the matching entry.",
    "",
    "This rule is ADDITIVE — it does not replace the E2E / verification",
    "contract. A turn updates memory AND runs its checks; neither excuses",
    "skipping the other.",
  ].join("\n");
}

/**
 * Playwright E2E-testing context appended to every chat request's system
 * prompt. Tells the model that a long-running `ai-ide-playwright` Docker
 * container is available with Playwright + Chromium + Firefox + WebKit
 * pre-installed, and how to drive it for tests / browser automation.
 *
 * Installed by `scripts/cloud-init.sh` Step 8.
 */
function buildPlaywrightContext(): string {
  return [
    "# ⚠️ E2E TESTING — THE HARDEST RULE IN THIS WORKSPACE ⚠️",
    "",
    "The user has called you out, REPEATEDLY across sessions, for skipping",
    "Playwright E2E tests and still saying \"done\". Their exact words:",
    "",
    "> \"main na=pnae ai-chat penal ko kuch bi bola hon tu wo proper us ki",
    "> e2e testing na kr pa raha ku ? es ko es bt pae strict karo kae e2e",
    "> testing zarori hay\"",
    "",
    "Translation: \"whatever I tell the AI chat panel, it doesn't properly",
    "do E2E testing of it. Be strict about this — E2E testing is mandatory.\"",
    "",
    "They treat an unverified \"done\" as a TRUST BREAK. Do not hand back",
    "\"done\" / \"finished\" / \"complete\" / \"here you go\" / similar wrap-up",
    "phrases without satisfying the checklist below.",
    "",
    "## THE COMPLETION CHECKLIST — print it verbatim before \"done\"",
    "",
    "For EVERY user turn that modified ANY code, your final message MUST",
    "include this checklist with REAL values from THIS turn — not vague",
    "\"all good\" claims:",
    "",
    "```",
    "Verification:",
    "  ✓ Type check: <paste the actual `tsc --noEmit` output line — \"0 errors\" or count>",
    "  ✓ Build:      <paste `npm run build` last line — size / time / \"build succeeded\">",
    "  ✓ E2E spec:   <path to the .spec.ts you wrote, e.g. tests/login.spec.ts>",
    "  ✓ E2E result: <paste the actual `playwright test` output line — \"1 passed (3.2s)\">",
    "```",
    "",
    "If you cannot tick all four, you have TWO choices:",
    "  (a) Run the missing checks NOW (before saying done), tick them, then say done.",
    "  (b) Say explicitly: \"I have NOT run <which step> because <specific concrete reason>.",
    "      Please tell me to proceed or to add the test.\" — and STOP. Do not say \"done\".",
    "",
    "Saying \"tests pass\" without quoting the actual output line counts as",
    "NOT having run them. The user verifies your claims. A claim that",
    "doesn't quote real output is treated as a lie.",
    "",
    "## E2E IS MANDATORY (the rule that's most often skipped)",
    "",
    "This workspace has a long-running Docker container named",
    "`ai-ide-playwright` with Playwright + Chromium + Firefox + WebKit",
    "pre-installed. It's ALWAYS available — assume it's up, restart if not.",
    "Use it. There is no excuse to ship a UI / HTTP change without a",
    "Playwright run against it.",
    "",
    "## When to run E2E (the default, not the exception)",
    "",
    "ANY of these in the turn = run E2E before \"done\":",
    "",
    "- Built or modified a page / route / form / button / modal",
    "- Wired up auth, routing, navigation, redirect, middleware",
    "- Added an HTTP endpoint (any framework — Next.js, Hono, Express, etc.)",
    "- Installed or configured a service that exposes a port (n8n, postgres-",
    "  admin, mailhog, redis-commander, etc.) — drive its UI in Playwright",
    "  to prove the URL actually responds with what you expected",
    "- Touched anything the user would click or open in a browser",
    "",
    "If the user said \"install X\" / \"set up X\" / \"deploy X\" and X has a",
    "web UI — that's IN scope. Don't dodge the test by claiming \"this is",
    "just installation, no test needed\". Drive the UI, prove it loaded.",
    "",
    "Type-checks and unit tests prove the code compiles; they don't prove",
    "the feature works. An E2E test is the last sanity check that the",
    "thing actually does what was asked.",
    "",
    "### Procedure at completion time",
    "",
    "1. Make sure the dev server / installed service is running and",
    "   registered through `register_service` (so it has a reachable URL).",
    "2. If the project doesn't have Playwright scaffolded yet, scaffold it",
    "   (see \"Scaffolding\" below) — one-time cost per project.",
    "3. Write a `.spec.ts` covering the golden path of what you just built.",
    "   Keep it tight — 1-3 assertions, no exhaustive matrix.",
    "4. Run the test inside `ai-ide-playwright` (see \"Running tests\" below).",
    "5. Paste the actual result line into the completion checklist above.",
    "   - ✓ pass → \"1 passed (3.2s)\" with `chromium` listed",
    "   - ✗ fail → show the failure, fix it, re-run. Don't hand off broken.",
    "",
    "### The ONLY allowed exits from the E2E rule",
    "",
    "(\"It's a small change\", \"I'm confident this works\", \"the change is",
    "obvious\", \"this is just installation\", \"no time\" — NONE of these are",
    "valid exits. The user does not trust your confidence; they trust",
    "passing test output.)",
    "",
    "- The turn was 100% terminal/file work with ZERO UI surface AND zero",
    "  HTTP server involved (e.g. \"rename a private helper function\",",
    "  \"add a code comment\", \"fix a typo in README.md\"). Anything that",
    "  binds a port or renders HTML is NOT in this bucket.",
    "- The user typed \"don't test\" / \"skip e2e\" / \"no tests please\" in",
    "  THIS turn's prompt. (A past preference doesn't count — they must",
    "  say it now.)",
    "- The Playwright container is genuinely unreachable AND you have",
    "  surfaced that with the actual docker error (e.g. \"docker exec",
    "  ai-ide-playwright … → no such container\"). Don't claim",
    "  unreachability without trying.",
    "",
    "When in doubt — RUN THE TEST. 5 seconds of Playwright is cheaper",
    "than handing back a broken \"done\" the user has to re-verify.",
    "",
    "### What a minimal completion test looks like",
    "",
    "```ts",
    "// tests/<feature>.spec.ts",
    "import { test, expect } from '@playwright/test';",
    "",
    "test('login form submits and lands on /dashboard', async ({ page }) => {",
    "  await page.goto('http://host.docker.internal:3000/login');",
    "  await page.getByLabel('Email').fill('demo@example.com');",
    "  await page.getByLabel('Password').fill('demo-password');",
    "  await page.getByRole('button', { name: /sign in/i }).click();",
    "  await expect(page).toHaveURL(/\\/dashboard/);",
    "});",
    "```",
    "",
    "One test, golden path, real assertion. That's the bar.",
    "",
    "## Container quick reference",
    "",
    "- Image:    `mcr.microsoft.com/playwright:v1.49.0-jammy`",
    "- Mount:    workspace root → `/work` inside the container (files you",
    "            write there appear on the host immediately)",
    "- Lifetime: `restart=unless-stopped` — assume it's already up",
    "- Compose:  `~/AI-IDE/playwright/docker-compose.yml`",
    "",
    "## Scaffolding (first time only, per project subfolder)",
    "",
    "If the current project subfolder has no `tests/` + `playwright.config.*`:",
    "",
    "```bash",
    "docker exec -w /work/<subfolder> ai-ide-playwright \\",
    "  npm init playwright@latest -- --quiet --browser=chromium --lang=ts",
    "```",
    "",
    "## Running tests",
    "",
    "Always exec inside the container — the host may not have Node, browsers,",
    "or OS deps. Set the working dir to the project subfolder:",
    "",
    "```bash",
    "docker exec -w /work/<subfolder> ai-ide-playwright npx playwright test",
    "docker exec -w /work/<subfolder> ai-ide-playwright npx playwright test tests/login.spec.ts",
    "docker exec -w /work/<subfolder> ai-ide-playwright npx playwright test --reporter=line",
    "```",
    "",
    "## Reaching host services from inside the container",
    "",
    "A dev server on the host is NOT reachable as `localhost` from inside the",
    "container. Use `host.docker.internal` instead:",
    "",
    "```ts",
    "await page.goto('http://host.docker.internal:3000');",
    "```",
    "",
    "For services already exposed through the workspace edge proxy (see the",
    "Workspace environment section above), the public proxy URL works from",
    "either the host or the container — prefer that.",
    "",
    "## Conventions",
    "",
    "- Place spec files under `<subfolder>/tests/`, suffix `.spec.ts`.",
    "- Default to Chromium (`--browser=chromium`). It's the fastest and is",
    "  what the AI panel itself drives.",
    "- Headed / debug runs require a display server the container doesn't",
    "  have. If the user wants a headed run, suggest they install Playwright",
    "  locally instead and run on the host.",
    "- After scaffolding, surface the test command back to the user as a",
    "  one-line copy-paste — they'll want to re-run it.",
    "",
    "## Failure recovery",
    "",
    "If `docker exec ai-ide-playwright …` errors with **\"no such container\"**:",
    "",
    "1. Container probably isn't running. Bring it back up:",
    "   `docker compose -f ~/AI-IDE/playwright/docker-compose.yml up -d`",
    "2. If Docker itself is missing (`docker: command not found`), tell the",
    "   user to re-run `scripts/cloud-init.sh` — Step 8 installs Docker AND",
    "   starts the Playwright container.",
    "",
    "Do NOT try to install Playwright or browsers globally on the host as a",
    "fallback — the container is the supported path. The host may be locked",
    "down or missing OS deps the browsers need.",
  ].join("\n");
}

/**
 * HyperFrames video-generation context. Tells the model that when the
 * user asks for any moving-image deliverable (product launch video, code
 * walkthrough, social clip, animated explainer, etc.) it should follow
 * the install-hyperframes skill — render HTML→MP4 inside the existing
 * `ai-ide-playwright` Docker container.
 *
 * Installed by `skills/install-hyperframes/` and bootstrapped by the
 * skill's own install.sh (FFmpeg + Node 22 + hyperframes CLI inside the
 * container).
 */
function buildHyperframesContext(): string {
  return [
    "# Video generation with HyperFrames",
    "",
    "When the user asks for a **video / animation / explainer / social",
    "clip / product launch reel / code walkthrough / data-viz animation**",
    "— anything that produces an MP4 — use the `install-hyperframes`",
    "skill at `~/.claude/skills/install-hyperframes/`.",
    "",
    "## When to invoke (default, not opt-in)",
    "",
    "Trigger this flow on ANY of these phrases (and similar):",
    "- \"make a video\", \"create an animation\", \"render a clip\"",
    "- \"animate this code\", \"walkthrough video\"",
    "- \"product launch video\", \"explainer\", \"intro reel\"",
    "- \"social clip\", \"TikTok\", \"Reel\", \"YouTube short\"",
    "- \"animated chart\", \"data-viz video\"",
    "",
    "Do NOT refuse with \"I can't make videos\" — HyperFrames is the answer.",
    "It renders HTML/CSS/JS animations to deterministic MP4 via Puppeteer",
    "+ FFmpeg inside the `ai-ide-playwright` container.",
    "",
    "## Procedure summary",
    "",
    "1. **First time per workspace** — run the setup once (idempotent):",
    "   ```bash",
    "   bash ~/.claude/skills/install-hyperframes/install.sh",
    "   ```",
    "   This installs FFmpeg + Node 22 + hyperframes CLI + Python +",
    "   google-genai SDK + the generate_asset.py helper inside the",
    "   `ai-ide-playwright` container. Re-runs skip work that's done.",
    "",
    "1a. **Asset source** — ALWAYS ask the user before scaffolding:",
    "    ```",
    "    For this video I'll need some images. Two options:",
    "    1) You upload them — drop files into",
    "       ~/AI-IDE/videos/<slug>/assets/ via VS Code file explorer.",
    "    2) I generate them with Gemini Imagen (~$0.04 per image,",
    "       paid on the operator's Google AI account).",
    "    Which would you like?",
    "    ```",
    "    Wait for the answer. Mixed responses are fine (\"my logo +",
    "    you generate the background\") — handle each asset per-path.",
    "",
    "    For Gemini-generated assets, the call inside the container is:",
    "    ```bash",
    "    docker exec ai-ide-playwright python3 /opt/hyperframes/generate_asset.py \\",
    "      --prompt \"<detailed description>\" \\",
    "      --output /work/videos/<slug>/assets/<name>.png \\",
    "      --aspect 16:9   # or 1:1 / 9:16 / 3:4 / 4:3",
    "    ```",
    "    Success line: `ok /work/...png (N bytes, 16:9)`.",
    "    Non-zero exit → see SKILL.md \"Step 2.5\" for the error table.",
    "",
    "    If `GEMINI_API_KEY` isn't set, generate_asset.py exits 1 with a",
    "    clear message. Tell the user the operator needs to add it to",
    "    `/etc/workspace.env` and restart the playwright container.",
    "    Don't pretend it worked — assets won't appear in the video.",
    "",
    "2. **Scaffold** under `~/AI-IDE/videos/<kebab-slug>/`:",
    "   ```bash",
    "   mkdir -p ~/AI-IDE/videos/<slug>",
    "   docker exec -w /work/videos/<slug> ai-ide-playwright \\",
    "     npx hyperframes init . --yes",
    "   ```",
    "",
    "3. **Write the video** by editing `index.html` on the host (mounted",
    "   into the container as `/work/videos/<slug>/`). Reference the",
    "   RECIPES.md inside the skill for ready-made templates: product",
    "   launch, vertical social, code walkthrough, animated bar chart.",
    "",
    "4. **Render**:",
    "   ```bash",
    "   docker exec -w /work/videos/<slug> ai-ide-playwright \\",
    "     npx hyperframes render --output output.mp4",
    "   ```",
    "   This is the slow step (10-30s of wall-clock per 1s of video on",
    "   t3.medium). Tell the user the wait upfront — don't promise sub-",
    "   minute renders.",
    "",
    "5. **Surface the file** to the user with a one-off static-file",
    "   server + `register_service`, so the MP4 opens as a clickable",
    "   link in the chat:",
    "   ```bash",
    "   cd ~/AI-IDE/videos/<slug>",
    "   python3 -m http.server 7100 &",
    "   ```",
    "   Then call `register_service(port=7100, name=\"video-<slug>\")` and",
    "   surface the returned URL as:",
    "   `[Watch <title>](http://video-<slug>-USER.DOMAIN/output.mp4)`",
    "",
    "## When to SKIP this skill",
    "",
    "- User asks for a static image / screenshot → use a regular",
    "  Playwright screenshot, not a video render.",
    "- User asks for realistic human faces / AI avatars → out of scope.",
    "  HTML/CSS/JS only; explain the limitation and offer an animated",
    "  illustrative alternative.",
    "- User asks for audio narration → render the silent MP4 first, then",
    "  tell them to mux audio separately with FFmpeg.",
    "",
    "## Honest limitations to surface",
    "",
    "- No audio track (video-only framework).",
    "- Custom fonts need a `<link>` to a CDN (or base64-embedded font",
    "  data for offline determinism).",
    "- Render time scales linearly with duration × fps. A 30s video at",
    "  1080p/60fps typically renders in 5-15 minutes.",
    "",
    "Don't promise what HyperFrames can't deliver — set expectations",
    "before the user invests time in a long render that produces something",
    "they didn't want.",
  ].join("\n");
}

/**
 * Long-running-process persistence context. Bash commands Claude runs
 * via the SDK are children of the chat-handler process; when the user
 * closes the browser tab the chat session ends and those children get
 * SIGKILL'd. Dev servers / watchers / daemons die with the session —
 * Traefik's registration survives, so the user comes back, opens the
 * URL, and gets a 502 Bad Gateway with no obvious cause.
 *
 * The fix is on the spawn side: detach long-running processes via tmux
 * (preferred — re-attachable) or setsid + nohup. This context teaches
 * the model the pattern so the user doesn't have to ask.
 */
function buildPersistenceContext(): string {
  return [
    "# Long-running processes — persistence across chat sessions",
    "",
    "When you start any process that should outlive THIS chat (dev",
    "servers, watchers, daemons, log followers), DO NOT run it directly",
    "with bash — the process becomes a child of the chat handler and gets",
    "killed when the user closes the browser or the session ends. The",
    "Traefik service registration survives that kill, so the next time",
    "the user opens the workspace URL they see a 502 Bad Gateway with",
    "no obvious cause.",
    "",
    "ALWAYS wrap long-running processes in one of these patterns:",
    "",
    "## Pattern A — tmux + recipe (preferred)",
    "",
    "Re-attachable; the user can `tmux attach -t <name>` later to see live",
    "output. Best default for dev servers.",
    "",
    "**ALWAYS do both of these together** so the service survives BOTH",
    "browser close (tmux) AND EC2 reboots (recipe restored by",
    "ai-ide-services.service on boot):",
    "",
    "```bash",
    "# 1. Save a recipe — the boot-restoration unit replays this after reboot.",
    "mkdir -p ~/.ai-ide/services",
    "cat > ~/.ai-ide/services/<session-name>.sh <<'RECIPE'",
    "cd <dir> && <command>",
    "RECIPE",
    "chmod +x ~/.ai-ide/services/<session-name>.sh",
    "",
    "# 2. Start the tmux session, sourcing the recipe so dev-time + boot-time",
    "#    behavior are identical.",
    "tmux new -d -s <session-name> 'bash ~/.ai-ide/services/<session-name>.sh'",
    "```",
    "",
    "Examples (frontend, backend, Odoo, custom Python app):",
    "```bash",
    "# Frontend (Next.js)",
    "mkdir -p ~/.ai-ide/services",
    "cat > ~/.ai-ide/services/frontend.sh <<'RECIPE'",
    "cd ~/AI-IDE/frontend && npm run dev",
    "RECIPE",
    "chmod +x ~/.ai-ide/services/frontend.sh",
    "tmux new -d -s frontend 'bash ~/.ai-ide/services/frontend.sh'",
    "",
    "# Odoo (bare-metal with venv)",
    "cat > ~/.ai-ide/services/odoo.sh <<'RECIPE'",
    "cd ~/odoo19 && source .venv/bin/activate && python odoo-bin -c debian/odoo.conf",
    "RECIPE",
    "chmod +x ~/.ai-ide/services/odoo.sh",
    "tmux new -d -s odoo 'bash ~/.ai-ide/services/odoo.sh'",
    "",
    "# Custom Python app",
    "cat > ~/.ai-ide/services/my-app.sh <<'RECIPE'",
    "cd ~/projects/my-app && python manage.py runserver 0.0.0.0:8000",
    "RECIPE",
    "chmod +x ~/.ai-ide/services/my-app.sh",
    "tmux new -d -s my-app 'bash ~/.ai-ide/services/my-app.sh'",
    "```",
    "",
    "Re-attach (visible to user):  `tmux attach -t <session-name>`",
    "Detach without killing:       Ctrl+B then D",
    "Kill the session:             `tmux kill-session -t <session-name>`",
    "List sessions:                `tmux ls`",
    "Remove recipe (won't auto-start on reboot):  `rm ~/.ai-ide/services/<name>.sh`",
    "",
    "## Pattern B — setsid + nohup (fallback)",
    "",
    "Use when tmux isn't appropriate (no re-attach needed, fire-and-forget).",
    "",
    "```bash",
    "setsid nohup <command> > /tmp/<name>.log 2>&1 < /dev/null &",
    "disown",
    "```",
    "",
    "The combination fully detaches: setsid creates a new session, nohup",
    "ignores SIGHUP, I/O is redirected away from the terminal, disown",
    "removes the job from the shell's job table.",
    "",
    "## When the rule applies",
    "",
    "Use a persistent wrapper for ALL of these (long-running, port-binding):",
    "",
    "- `npm/yarn/pnpm run dev | start | serve | preview`",
    "- `next dev`, `vite`, `webpack serve`, `parcel serve`",
    "- `python -m http.server`, `flask run`, `uvicorn`, `fastapi dev`",
    "- `docker compose up` (without `-d`)",
    "- `tail -f`, `watch`, log followers",
    "- anything that prints continuously and doesn't exit",
    "",
    "DO NOT wrap one-shot commands (they finish before session end):",
    "- `npm install`, `git clone`, `mkdir`, `cp`, `mv`",
    "- `npm run build`, `tsc`, lint runs",
    "- `docker compose up -d` (already detached by `-d`)",
    "",
    "## After starting — verify it actually persisted",
    "",
    "ALWAYS confirm the port is listening before claiming the service",
    "is up:",
    "",
    "```bash",
    "sleep 3 && ss -tlnp 2>/dev/null | grep ':<port> ' \\",
    "  || echo 'WARNING: nothing listening on <port>'",
    "```",
    "",
    "Then register + surface the URL:",
    "",
    "```",
    "register_service(port=<port>, name=\"<service-name>\")",
    "→ returns public URL",
    "```",
    "",
    "And reply with the link button: `[Open <name>](<url>)`.",
    "",
    "## Naming: register_service ↔ restart strategy",
    "",
    "The `name` you pass to `register_service` is the LOOKUP KEY the",
    "watchdog (ai-ide-watchdog.service) uses to figure out HOW to restart",
    "the service when it dies. It checks, in order:",
    "",
    "1. `~/.ai-ide/services/<name>.sh` — Pattern A recipe (what YOU write)",
    "2. `<name>.service` — systemd unit (for apt / system packages)",
    "3. docker container named `<name>` (for `docker run` / compose)",
    "",
    "Rules:",
    "",
    "- If you started the service via Pattern A, the recipe filename MUST",
    "  exactly match the `name` you pass: `register_service(name=\"odoo\")`",
    "  → `~/.ai-ide/services/odoo.sh`. NOT `odoo-test.sh`, NOT `odoo19.sh`.",
    "  The filename is the watchdog's lookup key — mismatch = no auto-restart.",
    "- If you omit `name`, the registered name is `port-<port>`, so the",
    "  recipe must be `~/.ai-ide/services/port-<port>.sh`. Prefer passing",
    "  an explicit `name` so the recipe filename is meaningful.",
    "- If you used Pattern B (setsid + nohup), drop a recipe too with the",
    "  same start command — otherwise the watchdog can't bring it back.",
    "- If the service is a system package (e.g. `apt install postgresql`",
    "  → `postgresql.service`), register it with `name=\"postgresql\"` and",
    "  skip the recipe — the watchdog auto-discovers the systemd unit.",
    "",
    "If you ever call `register_service` without one of these three",
    "restart-strategies in place, the service is unrecoverable after the",
    "first crash and the user gets 502 forever. Don't.",
    "",
    "## When the user reports \"Bad Gateway\" or \"502\"",
    "",
    "Almost always means: registration entry exists but the upstream",
    "process is dead. Diagnose in order:",
    "",
    "1. `ss -tlnp | grep ':<port>'` — empty means the process is dead.",
    "2. `tmux ls` — see if the tmux session that was supposed to host",
    "   it is still around. If not, the user closed the browser and",
    "   the previous (non-tmux) process died.",
    "3. Restart with one of the persistent patterns above.",
    "4. Verify again — only THEN tell the user the service is back.",
    "",
    "Don't say \"everything looks fine\" without actually checking the",
    "upstream process — that's the most common failure mode users hit",
    "and it makes the workspace feel broken.",
  ].join("\n");
}

/**
 * Code organization context — when the model is asked to build a website,
 * an app, or any new project from scratch, it MUST produce export-ready
 * code: industry-standard folder structure, one component per file,
 * proper naming, and a README. The user plans to hand the exported code
 * off to a developer, so a single mega-file dump is unacceptable even
 * if it "works".
 *
 * This is purely additive — it doesn't override the verification context,
 * the Playwright context, or any other behavior. It just sets the bar
 * for HOW code is organized when the model writes it.
 */
function buildCodeOrganizationContext(): string {
  return [
    "# Code organization — production-grade structure (DEFAULT, not opt-in)",
    "",
    "When the user asks you to build a new project, page, feature, or",
    "scaffold of any kind (e.g. \"build me a landing page\", \"make a",
    "dashboard\", \"create a website using this env pack\"), you MUST",
    "produce code that is **export-ready** — meaning the user can zip the",
    "project, hand it to a developer they hired, and that developer can",
    "open it and understand what's where without asking questions.",
    "",
    "This is the default. Apply it even when the user did not explicitly",
    "ask for \"clean code\" or \"proper structure\". A single-file demo dump",
    "is the wrong answer unless the user explicitly asked for a one-file",
    "throwaway.",
    "",
    "## Step 1 — pick the right framework",
    "",
    "If an environment pack is installed and recommends a stack, USE THAT",
    "stack — don't substitute. Otherwise, pick the smallest sensible",
    "framework for what the user asked for:",
    "",
    "| User asked for                | Use                              |",
    "| ----------------------------- | -------------------------------- |",
    "| Marketing / landing page      | Next.js (App Router) + Tailwind  |",
    "| Dashboard / app with auth     | Next.js (App Router) + Tailwind  |",
    "| Static brochure / portfolio   | Astro or Next.js static export   |",
    "| Backend API                   | Node + Hono (or Express)         |",
    "| Full-stack CRUD               | Next.js with API routes          |",
    "| CLI tool                      | Node + TypeScript + commander    |",
    "",
    "Confirm framework once with the user only if the request is genuinely",
    "ambiguous (e.g. \"build me an app\" with no other context). Otherwise",
    "pick and proceed.",
    "",
    "## Step 2 — scaffold a real project, not loose files",
    "",
    "Every new project gets, at minimum:",
    "",
    "- A proper `package.json` with `name`, `scripts` (`dev`, `build`,",
    "  `start`, `lint`, `typecheck`), and pinned-or-caret-ranged deps.",
    "- A `tsconfig.json` with `strict: true` for TypeScript projects.",
    "- A `.gitignore` that excludes `node_modules/`, `.next/`, `dist/`,",
    "  `.env`, `.env.local`, IDE cruft (`.vscode/`, `.idea/`).",
    "- A `README.md` with: one-line description, prerequisites,",
    "  `npm install` + `npm run dev` quick start, folder map, env-var list",
    "  if any.",
    "- An `.env.example` (NOT `.env`) if the project needs any secrets.",
    "- A linter config (`eslint.config.js` or equivalent) and a",
    "  formatter config (`.prettierrc`) for non-trivial projects.",
    "",
    "## Step 3 — folder layout",
    "",
    "### Next.js (App Router) — the default for web work",
    "",
    "```",
    "src/",
    "├── app/                    # routes only — page.tsx, layout.tsx, loading.tsx",
    "│   ├── (marketing)/        # route groups for shared layouts",
    "│   │   ├── layout.tsx",
    "│   │   └── page.tsx",
    "│   └── dashboard/",
    "│       └── page.tsx",
    "├── components/             # reusable UI — ONE component per file",
    "│   ├── ui/                 # primitives (Button, Input, Card)",
    "│   └── sections/           # composite blocks (Hero, Pricing, Footer)",
    "├── hooks/                  # useXxx() — one hook per file",
    "├── lib/                    # framework-agnostic helpers (db client,",
    "│                           # auth client, fetcher, env validation)",
    "├── utils/                  # pure functions (formatDate, cn, slugify)",
    "├── types/                  # shared TypeScript types/interfaces",
    "├── constants/              # enums, route maps, copy strings",
    "└── styles/                 # globals.css, tailwind base layers",
    "public/                     # static assets — images, fonts, favicons",
    "```",
    "",
    "### React (Vite) SPA",
    "",
    "Same as Next.js minus `app/`. Use `src/pages/` or `src/routes/` for",
    "route components and a router config in `src/lib/router.tsx`.",
    "",
    "### Node / Hono / Express backend",
    "",
    "```",
    "src/",
    "├── index.ts                # server bootstrap only",
    "├── routes/                 # one file per resource (users.ts, posts.ts)",
    "├── handlers/               # request handlers, called by routes",
    "├── services/               # business logic, no HTTP knowledge",
    "├── db/                     # client + schema + migrations",
    "├── middleware/             # auth, logging, CORS, rate-limit",
    "├── types/                  # shared types",
    "└── utils/                  # pure helpers",
    "```",
    "",
    "## Step 4 — file-level rules",
    "",
    "1. **One component per file.** `Hero.tsx` exports `Hero`. Not three",
    "   components in one file. Sub-components used only by `Hero` can",
    "   live in the same file IF they're trivial; otherwise split.",
    "2. **Name files after what they export.** PascalCase for components",
    "   (`Hero.tsx`), camelCase for hooks/utils (`useAuth.ts`,",
    "   `formatDate.ts`), kebab-case for route segments and config",
    "   (`page.tsx`, `next.config.mjs`).",
    "3. **Keep files under ~250 lines.** If a component is longer, you're",
    "   missing a sub-component or a hook. Extract.",
    "4. **No inline logic dumps.** Data fetching → hook or server",
    "   function. Validation → util or zod schema. Styling → Tailwind",
    "   classes or a co-located `.module.css`.",
    "5. **Types co-located OR in `types/`.** Prop types in the same file",
    "   as the component (`type HeroProps = ...`). Cross-cutting domain",
    "   types in `src/types/` (e.g. `User`, `Product`).",
    "6. **No magic strings.** Repeated copy → `constants/`. Repeated route",
    "   paths → `constants/routes.ts`.",
    "7. **No hardcoded secrets.** Env vars go through a validated",
    "   `src/lib/env.ts` (zod-validated) and are loaded from `.env.local`.",
    "",
    "## Step 5 — what NOT to do",
    "",
    "- Don't dump everything into `App.tsx` or `page.tsx`.",
    "- Don't create a 600-line component because \"it works\".",
    "- Don't skip the README — the export is half-broken without it.",
    "- Don't commit `node_modules/` or `.env` — gitignore them up front.",
    "- Don't invent a folder structure that doesn't match the framework's",
    "  conventions. The developer receiving this code expects Next.js to",
    "  look like Next.js.",
    "- Don't ask the user \"should I split this into components?\" — the",
    "  answer is always yes for anything non-trivial. Just do it.",
    "",
    "## Step 6 — when the user is iterating on an existing project",
    "",
    "If the project already exists (you're adding a feature, not",
    "scaffolding from scratch), MATCH the existing structure even if it's",
    "not what you'd pick fresh. Don't \"clean up\" unrelated files. The",
    "rules above apply to NEW files and NEW projects; for existing ones,",
    "respect the conventions already in the repo.",
  ].join("\n");
}

// Tools whose response path we don't wire through our frontend. Populate as
// new ones surface. AskUserQuestion now has a custom modal handler in the
// frontend that intercepts the tool_use block, shows a popup, and sends the
// user's answer back as a follow-up chat message — so it stays allowed.
const DISALLOWED_TOOLS: string[] = [
  // The desktop MCP server exposes browser_navigate (alwaysLoad), and merely
  // dropping it from the allow-list didn't stop the model — it still called it
  // and replaced the user's whole workspace tab with the requested site. A hard
  // deny blocks the call outright, forcing the model to mcp__aiide__open_tab
  // (a new tab) to open sites. browser_navigate_back stays allowed for "go back".
  "mcp__desktopbrowser__browser_navigate",
];

/**
 * Backwards-compatible abort path. The frontend's existing
 * `/api/abort/:requestId` route stays wired up — we just delegate to the
 * task registry now. requestId === taskId (the frontend's generated id),
 * so a single registry lookup does the job.
 */
export function abortRequest(taskId: string): boolean {
  return abortTaskInRegistry(taskId);
}

/**
 * POST /api/chat
 *
 * Starts a background SDK task and returns `{ taskId }` immediately. The
 * SDK call runs detached in the task registry — surviving HTTP client
 * disconnects, browser closes, and network blips. The caller (or any
 * subsequent caller) reads the event stream from
 * `GET /api/chat/stream/:taskId` and can resume from any seq via
 * `?from=<seq>` after a reconnect.
 */
export async function handleChatRequest(c: Context) {
  const body = (await c.req.json()) as ChatRequest;
  const {
    message,
    sessionId,
    requestId,
    allowedTools,
    workingDirectory,
    permissionMode,
    model,
    attachments,
    origin,
  } = body;

  // For WhatsApp-originated turns with no caller-supplied cwd, default
  // to the user's home directory rather than the backend's own source
  // tree — that gives the agent a useful starting point for a friend's
  // cold-start question. For UI turns we leave it untouched so the
  // explicit workspace picker still wins.
  const effectiveWorkingDirectory =
    workingDirectory ?? (origin === "whatsapp" ? process.env.HOME ?? "/home/ubuntu" : undefined);

  // Only use cwd if it actually exists — a missing cwd causes ENOENT on spawn.
  const safeCwd =
    effectiveWorkingDirectory && existsSync(effectiveWorkingDirectory)
      ? effectiveWorkingDirectory
      : undefined;
  if (effectiveWorkingDirectory && !safeCwd) {
    warn(`Working directory does not exist, ignoring: ${effectiveWorkingDirectory}`);
  }

  const isContinue = typeof message === "string" && message.trim() === "continue";
  info("Chat request:", {
    requestId,
    sessionId: sessionId ?? null,
    isContinue,
    permissionMode: permissionMode ?? null,
    workingDirectory: safeCwd ?? null,
    callerAllowedTools: allowedTools ?? [],
    messagePreview: typeof message === "string" ? message.slice(0, 120) : null,
  });

  // Idempotent re-POST: if the frontend retries with the same id (auto-
  // retry on a flaky network), don't start a second SDK call. Return the
  // existing task — the stream endpoint will pick up from wherever it is.
  if (getTask(requestId)) {
    return c.json({ taskId: requestId, existed: true });
  }

  const abortController = new AbortController();
  const taskId = requestId;
  createTask({
    taskId,
    workingDirectory: safeCwd ?? null,
    abortController,
  });

  // Kick off the SDK runner in the background. We deliberately don't
  // await — the HTTP response returns immediately with the taskId. The
  // runner pushes events into the task registry's buffer, which any
  // connected stream subscriber receives live (or replays from a seq).
  void runChatTask({
    taskId,
    message,
    sessionId,
    safeCwd,
    permissionMode,
    model,
    allowedTools,
    attachments,
    abortController,
    origin,
  });

  return c.json({ taskId });
}

interface RunChatTaskArgs {
  taskId: string;
  message: string;
  sessionId?: string;
  safeCwd?: string;
  permissionMode?: ChatRequest["permissionMode"];
  model?: string;
  allowedTools?: string[];
  attachments?: ChatRequest["attachments"];
  abortController: AbortController;
  origin?: ChatRequest["origin"];
}

// ── Deterministic post-turn memory capture ────────────────────────────────
// The main agent can't be relied on to persist every durable fact — it often
// just replies "noted" without writing the file. So after each turn we run a
// CHEAP Haiku pass that DECIDES what's worth remembering, and THIS BACKEND
// writes it to ~/.claude/CLAUDE.md (Claude Code's native, auto-loaded memory).
// The model only judges; the file write is code, so capture can't be skipped.
// Facts live in a delimited managed block so they stay separate from the
// hand-curated parts of CLAUDE.md and dedupe cleanly.

const MEMORY_FILE = join(homedir(), ".claude", "CLAUDE.md");
const MEMORY_START = "<!-- ai-ide:auto-memory:start -->";
const MEMORY_END = "<!-- ai-ide:auto-memory:end -->";

function normalizeFact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Merge new fact bullets into the managed block. Returns the ones added. */
function mergeMemoryFacts(facts: string[]): string[] {
  let content = existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, "utf8") : "";
  const sIdx = content.indexOf(MEMORY_START);
  const eIdx = content.indexOf(MEMORY_END);
  let existing: string[] = [];
  if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
    existing = content
      .slice(sIdx, eIdx)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "));
  }
  const seen = new Set(existing.map((l) => normalizeFact(l.replace(/^-\s*/, ""))));
  const contentNorm = normalizeFact(content);
  const added: string[] = [];
  for (const f of facts) {
    const clean = f.trim().replace(/^[-*]\s*/, "").replace(/\s+/g, " ");
    const n = normalizeFact(clean);
    if (n.length < 4) continue;
    if (seen.has(n)) continue;
    // Already stated elsewhere in CLAUDE.md (e.g. a hand-written section) —
    // don't duplicate it into the auto block.
    if (contentNorm.includes(n)) continue;
    seen.add(n);
    added.push("- " + clean);
  }
  if (added.length === 0) return [];

  const block = [
    MEMORY_START,
    "# Remembered preferences & facts (auto-captured)",
    ...existing,
    ...added,
    MEMORY_END,
  ].join("\n");

  if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
    content = content.slice(0, sIdx) + block + content.slice(eIdx + MEMORY_END.length);
  } else {
    content = content.replace(/\s*$/, "") + "\n\n" + block + "\n";
  }
  writeFileSync(MEMORY_FILE, content, "utf8");
  return added;
}

/**
 * Run the cheap extraction pass over one finished turn and persist anything
 * durable. Fire-and-forget — never throws into the caller.
 */
async function captureMemoryFromTurn(userText: string, assistantText: string): Promise<void> {
  const u = (userText ?? "").trim();
  // Skip trivial turns: permission replies, "continue", one-word acks.
  if (u.length < 8) return;
  if (u.length < 16 && /^(continue|yes|no|y|n|ok|okay|sure|stop|go|thanks)\b/i.test(u)) return;

  const prompt = [
    "From the single chat turn below, extract DURABLE facts worth remembering",
    "across FUTURE sessions about THIS user or project. Output ONLY a JSON array",
    "of short strings (each ≤ 14 words).",
    "",
    "INCLUDE: stable preferences (tools, stack, style, workflow), the user's",
    "identity (name / role), explicit decisions, corrections they made, and",
    "stable project facts not obvious from code or git.",
    "EXCLUDE: one-off task details, transient state, secrets / tokens / keys, and",
    "anything a future session could re-derive by reading the repo.",
    "If nothing is durable, output exactly: []",
    "",
    "=== USER ===",
    u.slice(0, 3000),
    "",
    "=== ASSISTANT ===",
    (assistantText ?? "").slice(0, 3000),
    "",
    "JSON array only, no prose:",
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let raw = "";
  try {
    const res = query({
      prompt,
      options: {
        model: "claude-haiku-4-5",
        abortController: ctrl,
        ...(process.env.CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_PATH } : {}),
        allowedTools: [],
        includePartialMessages: false,
      },
    });
    for await (const m of res) {
      const mm = m as unknown as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
      if (mm.type === "assistant" && Array.isArray(mm.message?.content)) {
        for (const block of mm.message!.content!) {
          if (block.type === "text") raw += String(block.text ?? "");
        }
      }
    }
  } catch (err) {
    warn("auto-memory: extraction query failed: " + (err instanceof Error ? err.message : String(err)));
    return;
  } finally {
    clearTimeout(timer);
  }

  let facts: string[] = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return;
    facts = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return;
  }
  if (facts.length === 0) return;

  try {
    const added = mergeMemoryFacts(facts);
    if (added.length > 0) {
      info(`auto-memory: saved ${added.length} fact(s) to ~/.claude/CLAUDE.md`, { added });
    }
  } catch (err) {
    warn("auto-memory: merge/write failed: " + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * The background SDK runner. Spawned (not awaited) from handleChatRequest.
 * Pushes every event into the task registry instead of an HTTP stream —
 * subscribers attach/detach freely via the chatStream handler and the
 * task survives between connections.
 *
 * Mirrors the original in-handler logic 1:1: image attachments, system-
 * prompt appendage, token-usage forwarding, permission flow. The only
 * change is where output bytes go.
 */
async function runChatTask(args: RunChatTaskArgs): Promise<void> {
  const {
    taskId,
    message,
    sessionId,
    safeCwd,
    permissionMode,
    model,
    allowedTools,
    attachments,
    abortController,
    origin,
  } = args;

  // WhatsApp-originated turns bypass the three-trigger gate — replies
  // and prompts for this turn always route straight back to WhatsApp.
  // Whoever started the conversation owns answering it.
  const isWhatsAppTurn = origin === "whatsapp";

  // A new turn on an existing session means the user is engaged again —
  // cancel any pending "task complete, ping phone in 5 min" notify
  // tagged with this session. (Permission / AskUserQuestion deferreds
  // are taskId-scoped and clean themselves up when the underlying
  // prompt resolves.)
  if (sessionId) {
    cancelDeferredNotifyForSession(sessionId);
  }

  const openPermissions = new Set<string>();

  // ── Intent Guard Agent ────────────────────────────────────────────────────
  // Runs before query(). If the message is ambiguous (e.g. "employees ki
  // salary 50,000 karo" — query vs mass-update?), pauses and shows a
  // two-option clarification modal. The chosen interpretation is prepended
  // to the prompt so the main agent follows the correct scope.
  let promptPrefix = "";
  const capturedIntent = await runIntentGuard(
    taskId,
    message,
    pushEvent,
    abortController.signal
  );
  if (capturedIntent) {
    promptPrefix = capturedIntent.promptPrefix + "\n\n";
    setTaskCapturedIntent(taskId, capturedIntent);
  }

  // ── Tool Guard Agent — session history ───────────────────────────────────
  // Tracks high-impact tool approvals within this task so we can detect
  // dramatic scope escalation (e.g. approved 8 rows before, now 400).
  const toolGuardHistory = createSessionHistory();

  // ── Anomaly Detection Agent — action collector ───────────────────────────
  const executedActions: ExecutedAction[] = [];

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    // ───── Tool Guard Agent ─────
    // Runs FIRST — before absent-mode check. High-impact tools (financial,
    // mass-destructive, mass-write) must ALWAYS get user confirmation, even
    // when the user has been away for 5+ minutes. Absent-mode must never
    // silently allow a "DELETE FROM orders" or "transfer_funds" call.
    // Routine tools (reads, small writes) are allowed immediately and then
    // fall through to the absent-mode short-circuit below so the task
    // doesn't stall on every harmless file-read prompt.
    const toolAssessment = assessTool(
      toolName,
      options.description ?? "",
      input
    );
    if (toolAssessment.verdict === "allow") {
      // Routine tool — safe to let absent-mode handle the rest silently.
      info("ToolGuard auto-allowed:", { taskId, toolName, reason: toolAssessment.reason });
      return { behavior: "allow", updatedInput: input };
    }

    // High-impact tool detected — record it and fall through to confirmation
    // modal regardless of absent-mode state.
    recordApproval(toolGuardHistory, toolName, toolAssessment, "unknown");
    info("ToolGuard routing to confirmation modal:", {
      taskId,
      toolName,
      impactCategory: toolAssessment.impactCategory,
      reason: toolAssessment.reason,
    });

    // ───── Absent-mode short-circuit (routine tools only) ─────
    // Only reached when Tool Guard already allowed the tool above.
    // High-impact tools never reach this block — they always go to the modal.
    const taskAtStart = getTask(taskId);
    if (taskAtStart?.absentMode) {
      info("canUseTool auto-allowed (absent-mode):", {
        taskId,
        toolName,
        toolUseId: options.toolUseID,
      });
      return { behavior: "allow", updatedInput: input };
    }

    const { id, promise } = createPendingPermission({
      toolUseId: options.toolUseID,
      toolName,
      input,
    });
    openPermissions.add(id);

    const payload: PermissionRequestPayload = {
      id,
      toolUseId: options.toolUseID,
      toolName,
      input,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      blockedPath: options.blockedPath,
      decisionReason: options.decisionReason,
      suggestions: options.suggestions,
      // Tool Guard enrichment — tells the frontend this is a high-impact
      // confirmation, not a routine SDK permission gate.
      toolGuardReason: toolAssessment.reason,
      toolGuardImpactCategory: toolAssessment.impactCategory,
      toolGuardActionSummary: toolAssessment.actionSummary,
    };
    info("SDK canUseTool fired:", {
      taskId,
      id,
      toolName,
      toolUseId: options.toolUseID,
      blockedPath: options.blockedPath,
      decisionReason: options.decisionReason,
      suggestionCount: options.suggestions?.length ?? 0,
    });
    pushEvent(taskId, { type: "permission_request", data: payload });
    // Route the permission to WhatsApp. For WhatsApp-originated turns
    // the prompt always goes to the phone immediately — the friend who
    // asked owns answering it. For UI-originated turns, the three-
    // trigger gate (opt-in / absent / 5-min idle) decides.
    const permKey = `perm:${id}`;
    const firePermNotify = () => notifyPermission(taskId, payload);
    if (isWhatsAppTurn) {
      void firePermNotify();
    } else {
      void (async () => {
        const decision = await shouldNotifyWhatsApp();
        if (decision === "now") void firePermNotify();
        else if (decision === "defer-5min") {
          scheduleDeferredNotify(taskId, permKey, async () => {
            if (!openPermissions.has(id)) return; // resolved before timer fired
            await firePermNotify();
          });
        }
      })();
    }

    // ───── Timeout strategy: high-impact vs routine ─────
    //
    // High-impact tools (Tool Guard flagged): NO timeout — wait forever
    // until the user explicitly decides. Auto-allow would defeat the entire
    // purpose of the guard. The task stays paused indefinitely; only the
    // user's Allow/Deny click (or an explicit Stop) can unblock it.
    //
    // Routine SDK-gated tools: keep the 5-min auto-allow IFF WhatsApp is
    // NOT linked. When linked, the gate above has already routed the
    // prompt to the phone — auto-allowing would race the user's phone
    // reply. The task waits indefinitely for either an in-app decision
    // or a WhatsApp reply (handleIncomingMessage resolves the same
    // pending Promise).
    const isHighImpact = toolAssessment.impactCategory !== "routine";
    const whatsappLinked = await isWhatsAppLinked();

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (!isHighImpact && !whatsappLinked) {
      timeoutHandle = setTimeout(() => {
        if (!openPermissions.has(id)) return;
        info("canUseTool auto-allow (5-min timeout):", {
          taskId,
          id,
          toolName,
          toolUseId: options.toolUseID,
        });
        setTaskAbsentMode(taskId, true);
        autoAllowPending(id);
        openPermissions.delete(id);
        pushEvent(taskId, {
          type: "permission_resolved",
          data: { id, decision: "auto-allow", reason: "user-absent-timeout" },
        });
      }, PERMISSION_WAIT_MS);
    } else if (isHighImpact) {
      info("canUseTool waiting indefinitely (high-impact tool):", {
        taskId,
        id,
        toolName,
        impactCategory: toolAssessment.impactCategory,
      });
    } else {
      info("canUseTool waiting indefinitely (WhatsApp linked — phone takes over):", {
        taskId,
        id,
        toolName,
      });
    }

    const onAbort = () => {
      if (denyPending(id, "Aborted by user")) {
        openPermissions.delete(id);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      cancelDeferredNotify(taskId, permKey);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await promise;
      openPermissions.delete(id);
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      cancelDeferredNotify(taskId, permKey);
      options.signal.removeEventListener("abort", onAbort);
    }
  };

  try {
    const claudePath = process.env.CLAUDE_PATH;
    const mergedAllowedTools = [
      ...MCP_TOOL_NAMES,
      ...PLAYWRIGHT_TOOL_NAMES,
      ...(allowedTools ?? []),
    ];
    info("Invoking SDK query:", {
      taskId,
      mergedAllowedTools,
      resume: sessionId ?? null,
    });

    // Prepend Intent Guard's clarification prefix so the agent follows
    // the user's chosen interpretation (e.g. "query only" vs "update all").
    const effectiveMessage = promptPrefix + message;

    const promptInput =
      attachments && attachments.length > 0
        ? (async function* () {
            yield {
              type: "user" as const,
              parent_tool_use_id: null,
              message: {
                role: "user" as const,
                content: [
                  { type: "text" as const, text: effectiveMessage },
                  ...attachments.map((a) => ({
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: a.mediaType as
                        | "image/png"
                        | "image/jpeg"
                        | "image/gif"
                        | "image/webp",
                      data: a.base64,
                    },
                  })),
                ],
              },
              session_id: sessionId ?? "",
            };
          })()
        : effectiveMessage;

    const proxyContext = buildProxyContext();
    const completionContext = buildCompletionVerificationContext();
    const memoryContext = buildMemoryContext();
    const playwrightContext = buildPlaywrightContext();
    const desktopBrowserContext = PLAYWRIGHT_MCP_URL ? buildDesktopBrowserContext() : null;
    const hyperframesContext = buildHyperframesContext();
    const persistenceContext = buildPersistenceContext();
    const codeOrgContext = buildCodeOrganizationContext();
    // Ordering matters — the model reads these top-to-bottom and the
    // EARLIER sections carry more weight in long-context attention.
    // Playwright/E2E goes RIGHT after the workspace proxy notes so the
    // mandatory completion-checklist rule is one of the first things
    // the model sees, before any task-specific context loads in. User
    // explicitly complained that E2E was being skipped — front-loading
    // the rule is the cheapest fix we have without writing a runtime
    // enforcement hook.
    const appendedSystem = [
      proxyContext,
      desktopBrowserContext,
      playwrightContext,
      completionContext,
      memoryContext,
      hyperframesContext,
      persistenceContext,
      codeOrgContext,
    ]
      .filter((s): s is string => Boolean(s))
      .join("\n\n");

    // ───── Permission mode: HARD-FORCED to "bypassPermissions" ─────
    //
    // User explicitly asked for the SDK to "always allow everything" —
    // no canUseTool prompts, no per-tool gates, no 5-min waits. The
    // canonical SDK way is `permissionMode: "bypassPermissions"`, which
    // skips the canUseTool callback entirely.
    //
    // We OVERRIDE whatever the client sent in `permissionMode`. The mode
    // toggle in the chat header (default/plan/acceptEdits/bypass) still
    // exists for now but is effectively cosmetic — the "default" and
    // "acceptEdits" modes no longer ask, and "plan" mode's gate doesn't
    // fire either. If a future requirement reverses this, change ONLY
    // this constant and the override below.
    //
    // The 5-minute auto-allow timer + `absentMode` machinery in
    // canUseTool above become dead code under this override (canUseTool
    // is never called). Kept intact so flipping back to the asked-flow
    // is a one-line change.
    // Tool Guard + Intent Guard are now active — permissions must flow
    // through canUseTool so the guards can intercept.
    const FORCE_BYPASS_PERMISSIONS = false;
    const effectivePermissionMode = FORCE_BYPASS_PERMISSIONS
      ? ("bypassPermissions" as const)
      : permissionMode;

    if (FORCE_BYPASS_PERMISSIONS && permissionMode && permissionMode !== "bypassPermissions") {
      info("Overriding client permissionMode to bypass:", {
        taskId,
        clientSent: permissionMode,
        forcedTo: "bypassPermissions",
      });
    }

    const response = query({
      prompt: promptInput,
      options: {
        abortController,
        ...(sessionId ? { resume: sessionId } : {}),
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        ...(safeCwd ? { cwd: safeCwd } : {}),
        allowedTools: mergedAllowedTools,
        disallowedTools: DISALLOWED_TOOLS,
        ...(model ? { model } : {}),
        mcpServers: {
          aiide: createAiideMcpServer({ workspaceDir: safeCwd }),
          // Phase 4 — Playwright MCP via the reverse SSH tunnel to the
          // user's desktop app. `alwaysLoad` forces the tools into the
          // turn-1 prompt instead of being deferred behind tool search,
          // so the model sees them immediately without an extra step.
          ...(PLAYWRIGHT_MCP_URL
            ? { desktopbrowser: { type: "http" as const, url: PLAYWRIGHT_MCP_URL, alwaysLoad: true } }
            : {}),
        },
        // canUseTool is still passed for completeness — it'll just never
        // be invoked under bypassPermissions, but keeping it wired means
        // FORCE_BYPASS_PERMISSIONS = false re-enables the gate flow
        // without further code changes.
        canUseTool,
        ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
        ...(appendedSystem ? { appendSystemPrompt: appendedSystem } : {}),
        includePartialMessages: true,
        // ───── Auto-compaction: ENABLED ─────
        //
        // Previously hard-disabled (`autoCompactEnabled: false`), which is
        // exactly why the chat panel kept dying with "Prompt is too long":
        // a resumed session's transcript grows past the model's context
        // window and, with compaction off, the SDK has no way to shrink it
        // — so the very next message (even a one-word "go" / "no") overflows
        // and the turn errors out before it starts.
        //
        // With this true, the SDK auto-compacts (summarize older turns, keep
        // the recent tail) BEFORE a request would exceed the window, both
        // mid-conversation and pre-flight on resume. That self-heals an
        // already-bloated session: the next turn compacts first, then runs.
        //
        // `settings` is the highest-priority ("flag settings") layer, so this
        // wins over any project/user settings.json that might disable it.
        settings: { autoCompactEnabled: true },
      },
    });

    let detectedSessionId: string | null = sessionId ?? null;
    let messageCount = 0;
    let finalAssistantText = "";
    for await (const sdkMessage of response) {
      pushEvent(taskId, { type: "claude_json", data: sdkMessage });
      const msg = sdkMessage as unknown as {
        session_id?: string;
        type?: string;
        message?: { content?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      };
      if (msg.session_id) {
        detectedSessionId = msg.session_id;
        setTaskSessionId(taskId, msg.session_id);
        // Make the WhatsApp bridge aware of the active session so an
        // incoming WhatsApp message can resume the same conversation
        // instead of starting a fresh one.
        rememberSession({
          sessionId: msg.session_id,
          workingDirectory: safeCwd ?? null,
          permissionMode: permissionMode ?? null,
        });
      }
      if (msg.type === "assistant" || msg.type === "user") messageCount++;

      const usage = msg.usage ?? msg.message?.usage;
      if (usage) {
        const inputTokens = usage.input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const cacheCreate = usage.cache_creation_input_tokens ?? 0;
        const totalIn = inputTokens + cacheRead + cacheCreate;
        pushEvent(taskId, {
          type: "token_usage",
          data: { inputTokens: totalIn, outputTokens: usage.output_tokens ?? 0 },
        });
      }
      if (msg.type === "system") {
        const sysMsg = sdkMessage as unknown as {
          subtype?: string;
          tool_name?: string;
          tool_use_id?: string;
          decision_reason?: string;
          decision_reason_type?: string;
          message?: string;
        };
        if (sysMsg.subtype === "permission_denied") {
          warn("SDK permission_denied:", {
            taskId,
            tool: sysMsg.tool_name,
            tool_use_id: sysMsg.tool_use_id,
            reasonType: sysMsg.decision_reason_type,
            reason: sysMsg.decision_reason,
            message: sysMsg.message,
          });
        }
      }
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const t = block.type as string | undefined;
          if (t === "text") {
            // Collect final assistant response for Anomaly Detection
            finalAssistantText = String(block.text ?? "");
          } else if (t === "tool_use") {
            // Anomaly Detection: collect every tool execution
            executedActions.push({
              toolName: String(block.name ?? ""),
              input: (block.input as Record<string, unknown>) ?? {},
            });
            info("SDK tool_use:", {
              taskId,
              name: block.name,
              id: block.id,
              input: block.input,
            });
            if (block.name === "AskUserQuestion") {
              const qs =
                (block.input as {
                  questions?: Array<{
                    header?: string;
                    question?: string;
                    multiSelect?: boolean;
                    options?: Array<{ label?: string; description?: string }>;
                  }>;
                })?.questions ?? [];
              info("SDK AskUserQuestion detected:", {
                taskId,
                tool_use_id: block.id,
                questionCount: qs.length,
                headers: qs.map((q) => q.header),
                note: "Frontend modal will intercept; this SDK call will auto-error and be suppressed.",
              });
              // Route the question to WhatsApp per the three-trigger
              // gate. The user's reply lands in the bridge's
              // handleIncomingMessage path, which submits the answer
              // back to /api/chat as a follow-up turn on the same
              // session.
              const askToolUseId = String(block.id ?? "");
              const askKey = `ask:${askToolUseId}`;
              const fireAskNotify = () =>
                notifyAskUserQuestion({
                  taskId,
                  toolUseId: askToolUseId,
                  questions: qs,
                  sessionId: detectedSessionId,
                  workingDirectory: safeCwd ?? null,
                  permissionMode: permissionMode ?? null,
                });
              if (isWhatsAppTurn) {
                void fireAskNotify();
              } else {
                void (async () => {
                  const decision = await shouldNotifyWhatsApp();
                  if (decision === "now") void fireAskNotify();
                  else if (decision === "defer-5min") {
                    scheduleDeferredNotify(taskId, askKey, fireAskNotify, {
                      sessionId: detectedSessionId,
                    });
                  }
                })();
              }
            }
          } else if (t === "tool_result") {
            const isErr = (block.is_error as boolean) ?? false;
            let txt = "";
            if (typeof block.content === "string") {
              txt = block.content;
            } else if (Array.isArray(block.content)) {
              txt = (block.content as Array<Record<string, unknown>>)
                .map((c) => (typeof c === "string" ? c : ((c?.text as string) ?? "")))
                .filter(Boolean)
                .join("\n");
            }
            // Anomaly Detection: attach result summary + error flag to the
            // matching executed action (matched by position — tool_result
            // immediately follows its tool_use in the content array).
            const lastAction = executedActions[executedActions.length - 1];
            if (lastAction) {
              lastAction.resultSummary = txt.slice(0, 500);
              lastAction.isError = isErr;
            }
            if (isErr) {
              warn("SDK tool_result ERROR:", {
                taskId,
                tool_use_id: block.tool_use_id,
                text: txt.slice(0, 500),
                rawBlock: JSON.stringify(block).slice(0, 2000),
              });
            } else {
              info("SDK tool_result ok:", {
                taskId,
                tool_use_id: block.tool_use_id,
              });
            }
          }
        }
      }
    }

    if (detectedSessionId) {
      try { recordSession(detectedSessionId, safeCwd ?? null, messageCount); } catch { /* ignore */ }
    }

    // ── Anomaly Detection Agent ───────────────────────────────────────────
    // Runs silently after all tool calls are done. Compares what actually
    // happened against the user's captured intent (if Intent Guard ran).
    // Only pushes an event when severity is "low" or "high" — stays silent
    // on clean runs so the user sees no noise for routine tasks.
    if (executedActions.length > 0) {
      const task = getTask(taskId);
      const anomalyReport = runAnomalyDetection(
        task?.capturedIntent ?? null,
        executedActions,
        finalAssistantText
      );
      if (anomalyReport.severity !== "none") {
        pushEvent(taskId, { type: "anomaly_alert", data: anomalyReport });
      }
    }

    pushEvent(taskId, { type: "done" });
    setTaskStatus(taskId, "done");

    // ── Deterministic auto-memory ─────────────────────────────────────────
    // Fire-and-forget: a cheap Haiku pass extracts durable facts from this
    // turn and the backend writes them to ~/.claude/CLAUDE.md. Runs AFTER the
    // done event so it never delays the user's reply. Skipped for WhatsApp-
    // origin turns is unnecessary — preferences from any surface are worth
    // keeping — so we run it for all completed turns.
    void captureMemoryFromTurn(message, finalAssistantText);

    // Ping the user on WhatsApp with the agent's final text. WhatsApp-
    // originated turns fire the reply immediately (the friend who asked
    // is waiting); UI turns go through the three-trigger gate, with
    // the 5-min deferred case tagged with sessionId so a new chat turn
    // on the same session cancels the pending phone ping.
    const doneKey = "complete";
    const fireDoneNotify = () => notifyTaskDone(taskId, finalAssistantText);
    if (isWhatsAppTurn) {
      void fireDoneNotify();
    } else {
      void (async () => {
        const decision = await shouldNotifyWhatsApp();
        if (decision === "now") void fireDoneNotify();
        else if (decision === "defer-5min") {
          scheduleDeferredNotify(taskId, doneKey, fireDoneNotify, {
            sessionId: detectedSessionId,
          });
        }
      })();
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      pushEvent(taskId, { type: "aborted" });
      setTaskStatus(taskId, "aborted");
    } else {
      const msgText = err instanceof Error ? err.message : String(err);
      logError("Chat task error:", msgText);
      // "Prompt is too long" means the resumed transcript overflowed the
      // model's context window. With autoCompactEnabled now true the SDK
      // compacts pre-flight, so this should be rare — but if a single
      // session has ballooned past what even compaction can fit, the raw
      // SDK string is cryptic and leaves the user stuck. Surface an
      // actionable message instead.
      const isPromptTooLong = /prompt is too long/i.test(msgText);
      const userFacing = isPromptTooLong
        ? "This conversation grew too large for the model's context window. " +
          "Auto-compaction is enabled and normally shrinks it automatically, " +
          "but this session is big enough that it couldn't recover. Start a " +
          "new chat to continue — your files and work are unaffected."
        : msgText;
      pushEvent(taskId, { type: "error", error: userFacing });
      setTaskStatus(taskId, "error");
    }
  } finally {
    for (const id of openPermissions) {
      denyPending(id, "Task ended without a decision");
    }
    openPermissions.clear();
  }
}

export async function handleAbortRequest(c: Context) {
  const requestId = c.req.param("requestId");
  if (!requestId) return c.json({ success: false }, 400);
  const success = abortRequest(requestId);
  return c.json({ success });
}
