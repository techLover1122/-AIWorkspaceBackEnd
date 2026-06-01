import { Context } from "hono";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import type { ChatRequest, StreamResponse } from "../types.js";
import { info, warn, error as logError } from "../utils/logger.js";
import { recordSession } from "../utils/db.js";
import { createAiideMcpServer } from "../mcp/aiideTools.js";
import {
  createPendingPermission,
  denyPending,
  type PermissionRequestPayload,
} from "./permission.js";

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

/**
 * Workspace-environment context appended to every chat request's system
 * prompt. Without this the model treats the box as a normal Linux VM and
 * writes code with `http://localhost:<port>` URLs — which the user's
 * browser can't reach, since it's on a different origin (the edge proxy).
 *
 * Filled at request time from env so it reflects this specific workspace.
 */
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
    "After completing ANY user request that touches code in a project,",
    "BEFORE saying \"done\" / \"I've finished\" / \"here you go\":",
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
    "## Step 4 — for UI changes, ALSO run E2E",
    "",
    "If the change is user-visible (new page, form, button, layout), after",
    "the above checks pass, run the Playwright E2E rule described in the",
    "next section. That's the final sanity check that the feature actually",
    "WORKS in a browser, not just that the code compiles.",
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
 * Playwright E2E-testing context appended to every chat request's system
 * prompt. Tells the model that a long-running `ai-ide-playwright` Docker
 * container is available with Playwright + Chromium + Firefox + WebKit
 * pre-installed, and how to drive it for tests / browser automation.
 *
 * Installed by `scripts/cloud-init.sh` Step 8.
 */
function buildPlaywrightContext(): string {
  return [
    "# E2E testing with Playwright (Docker)",
    "",
    "This workspace has a long-running Docker container named",
    "`ai-ide-playwright` with Playwright + Chromium + Firefox + WebKit",
    "pre-installed. Use it for end-to-end tests and browser automation.",
    "",
    "## When to run E2E tests — project completion rule (DEFAULT, not opt-in)",
    "",
    "**After you finish a user-visible change to a project** — built a new",
    "page, added a form, wired up auth, fixed a UI bug, anything the user",
    "would interact with in a browser — you MUST run a Playwright E2E test",
    "against what you built BEFORE telling the user \"done\".",
    "",
    "**Do this even when the user did NOT ask for tests.** The user does not",
    "have to say \"and write an E2E test\" — E2E verification on completion",
    "is the default behavior of this workspace. Asking the user \"should I",
    "test it?\" is wrong — the answer is always yes unless one of the skip",
    "rules below applies.",
    "",
    "Type-checks and unit tests prove the code compiles; they don't prove",
    "the feature works. An E2E test is your last sanity check that the",
    "thing actually does what was asked.",
    "",
    "### Procedure at completion time",
    "",
    "1. Make sure the dev server for the project is running and registered",
    "   through `register_service` (so it has a reachable URL).",
    "2. If the project doesn't have Playwright scaffolded yet, scaffold it",
    "   (see \"Scaffolding\" below) — one-time cost per project.",
    "3. Write a `.spec.ts` covering the golden path of what you just built.",
    "   Keep it tight — 1-3 assertions, no exhaustive matrix.",
    "4. Run the test inside `ai-ide-playwright` (see \"Running tests\" below).",
    "5. Report the result to the user as part of your completion message:",
    "   - ✓ pass → \"Built X. E2E test passes (1 spec, Ns).\"",
    "   - ✗ fail → show the failure, fix it, re-run. Don't hand off broken.",
    "",
    "### When to SKIP this rule",
    "",
    "- Pure backend work with no UI surface (e.g. \"refactor this helper\").",
    "- Doc / comment / config tweaks.",
    "- One-shot scripts the user runs once and discards.",
    "- The user explicitly says \"don't test\" or \"just code, no tests\".",
    "- The feature can't be tested headlessly (file uploads from clipboard,",
    "  native OS dialogs). In that case, tell the user you skipped the E2E",
    "  step and why.",
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

// Tools whose response path we don't wire through our frontend. Populate as
// new ones surface. AskUserQuestion now has a custom modal handler in the
// frontend that intercepts the tool_use block, shows a popup, and sends the
// user's answer back as a follow-up chat message — so it stays allowed.
const DISALLOWED_TOOLS: string[] = [
];

const abortControllers = new Map<string, AbortController>();

export function abortRequest(requestId: string): boolean {
  const controller = abortControllers.get(requestId);
  if (!controller) return false;
  controller.abort();
  abortControllers.delete(requestId);
  return true;
}

export async function handleChatRequest(c: Context) {
  const body = (await c.req.json()) as ChatRequest;
  const {
    message,
    sessionId,
    requestId,
    allowedTools,
    workingDirectory,
    permissionMode,
    attachments,
  } = body;

  // Only use cwd if it actually exists — a missing cwd causes ENOENT on spawn.
  const safeCwd = workingDirectory && existsSync(workingDirectory) ? workingDirectory : undefined;
  if (workingDirectory && !safeCwd) {
    warn(`Working directory does not exist, ignoring: ${workingDirectory}`);
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

  const abortController = new AbortController();
  abortControllers.set(requestId, abortController);

  const stream = new ReadableStream({
    async start(controller) {
      // `controller.enqueue` throws after the stream is closed (e.g. the
      // heartbeat interval fires once more between `controller.close()` and
      // the JS event loop catching up). Swallow that specific case so a
      // shutdown race doesn't crash the request.
      let closed = false;
      const send = (data: StreamResponse) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
        } catch {
          // Stream already closed — nothing more we can do.
          closed = true;
        }
      };

      // Heartbeat: emit a tiny `{"type":"heartbeat"}` line every 15s while
      // the SDK is mid-turn. Reasons:
      //   1. The model itself can think for 30-90s before emitting any
      //      content — no bytes flow during that time.
      //   2. canUseTool blocks on the user clicking Allow/Deny — could be
      //      minutes of total silence.
      // Without periodic bytes, Traefik / Cloudflare / nginx kill the
      // connection at their default idle timeouts (~60s), and the frontend
      // sees it as a "network error". The heartbeat keeps it alive
      // indefinitely. The frontend parser silently ignores these lines.
      const HEARTBEAT_MS = 15_000;
      const heartbeatTimer = setInterval(() => {
        send({ type: "heartbeat" });
      }, HEARTBEAT_MS);

      // Track every pending permission we open so we can auto-deny on
      // stream abort (otherwise the SDK call hangs forever).
      const openPermissions = new Set<string>();

      // The structured permission callback. Replaces the regex-based
      // is_error parsing — SDK calls this for any tool that needs approval
      // and we surface a permission_request stream event with full context.
      const canUseTool: CanUseTool = async (toolName, input, options) => {
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
        };
        info("SDK canUseTool fired:", {
          requestId,
          id,
          toolName,
          toolUseId: options.toolUseID,
          blockedPath: options.blockedPath,
          decisionReason: options.decisionReason,
          suggestionCount: options.suggestions?.length ?? 0,
        });
        send({ type: "permission_request", data: payload });

        // If the SDK signals abort while we're waiting on the user, deny.
        const onAbort = () => {
          if (denyPending(id, "Aborted by user")) {
            openPermissions.delete(id);
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await promise;
          openPermissions.delete(id);
          return result;
        } finally {
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      try {
        const claudePath = process.env.CLAUDE_PATH;
        // Always make AI-IDE skills available; merge with any caller-allowed tools.
        const mergedAllowedTools = [
          ...MCP_TOOL_NAMES,
          ...(allowedTools ?? []),
        ];
        info("Invoking SDK query:", {
          requestId,
          mergedAllowedTools,
          resume: sessionId ?? null,
          isContinue,
        });
        // When the user sends images, hand them to Claude as proper
        // multimodal content blocks (base64 image sources). The default
        // string prompt would only carry the text — Claude would see
        // filenames like "annotation-12345.png" and try to Read them off
        // disk, which fails ("File does not exist").
        const promptInput =
          attachments && attachments.length > 0
            ? (async function* () {
                yield {
                  type: "user" as const,
                  parent_tool_use_id: null,
                  message: {
                    role: "user" as const,
                    content: [
                      { type: "text" as const, text: message },
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
                  // Required field on SDKUserMessage even though we don't
                  // have a session — the SDK fills this in when streaming.
                  session_id: sessionId ?? "",
                };
              })()
            : message;
        const proxyContext = buildProxyContext();
        const completionContext = buildCompletionVerificationContext();
        const playwrightContext = buildPlaywrightContext();
        const hyperframesContext = buildHyperframesContext();
        const persistenceContext = buildPersistenceContext();
        // Combine the five workspace-environment contexts into one
        // appendSystemPrompt blob. The model sees them as additional
        // sections after the Claude Agent SDK's own prompt:
        //   1. proxyContext       — URLs / ports / CORS / iframe rules
        //   2. completionContext  — broad verification suite (type-check,
        //                           lint, unit, build) before "done"
        //   3. playwrightContext  — E2E testing default rule (UI changes)
        //   4. hyperframesContext — HTML→MP4 video gen
        //   5. persistenceContext — tmux/recipes for long-running processes
        //                           (so dev servers survive browser-close
        //                           and EC2 reboots)
        const appendedSystem = [
          proxyContext,
          completionContext,
          playwrightContext,
          hyperframesContext,
          persistenceContext,
        ]
          .filter((s): s is string => Boolean(s))
          .join("\n\n");
        const response = query({
          prompt: promptInput,
          options: {
            abortController,
            ...(sessionId ? { resume: sessionId } : {}),
            ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
            ...(safeCwd ? { cwd: safeCwd } : {}),
            allowedTools: mergedAllowedTools,
            disallowedTools: DISALLOWED_TOOLS,
            mcpServers: { aiide: createAiideMcpServer({ workspaceDir: safeCwd }) },
            canUseTool,
            ...(permissionMode ? { permissionMode } : {}),
            ...(appendedSystem ? { appendSystemPrompt: appendedSystem } : {}),
          },
        });

        let detectedSessionId: string | null = sessionId ?? null;
        let messageCount = 0;
        for await (const sdkMessage of response) {
          send({ type: "claude_json", data: sdkMessage });
          const msg = sdkMessage as unknown as {
            session_id?: string;
            type?: string;
            message?: { content?: Array<Record<string, unknown>> };
          };
          if (msg.session_id) detectedSessionId = msg.session_id;
          if (msg.type === "assistant" || msg.type === "user") messageCount++;
          // Authoritative auto-deny signal from the SDK.
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
                requestId,
                tool: sysMsg.tool_name,
                tool_use_id: sysMsg.tool_use_id,
                reasonType: sysMsg.decision_reason_type,
                reason: sysMsg.decision_reason,
                message: sysMsg.message,
              });
            }
          }
          // Log every tool call + tool result so the backend console shows the
          // exact SDK signal that lead to a permission UI / error in the chat.
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const t = block.type as string | undefined;
              if (t === "tool_use") {
                info("SDK tool_use:", {
                  requestId,
                  name: block.name,
                  id: block.id,
                  input: block.input,
                });
                // Extra-loud log for AskUserQuestion so it's easy to spot in
                // the backend terminal when debugging the modal flow.
                if (block.name === "AskUserQuestion") {
                  const qs =
                    (block.input as { questions?: Array<{ header?: string; question?: string }> })
                      ?.questions ?? [];
                  info("SDK AskUserQuestion detected:", {
                    requestId,
                    tool_use_id: block.id,
                    questionCount: qs.length,
                    headers: qs.map((q) => q.header),
                    note: "Frontend modal will intercept; this SDK call will auto-error and be suppressed.",
                  });
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
                if (isErr) {
                  warn("SDK tool_result ERROR:", {
                    requestId,
                    tool_use_id: block.tool_use_id,
                    text: txt.slice(0, 500),
                    // Dump the full raw block so empty-body denials are
                    // visible (text/content-shape is hard to infer otherwise).
                    rawBlock: JSON.stringify(block).slice(0, 2000),
                  });
                } else {
                  info("SDK tool_result ok:", {
                    requestId,
                    tool_use_id: block.tool_use_id,
                  });
                }
              }
            }
          }
        }

        // Persist session metadata after stream completes
        if (detectedSessionId) {
          try { recordSession(detectedSessionId, safeCwd ?? null, messageCount); } catch { /* ignore */ }
        }

        send({ type: "done" });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          send({ type: "aborted" });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          logError("Chat error:", msg);
          send({ type: "error", error: msg });
        }
      } finally {
        // Stop the heartbeat BEFORE closing the controller — otherwise a
        // straggling tick can fire between close() and the timer being
        // cleared, and call enqueue() on a closed stream.
        clearInterval(heartbeatTimer);
        abortControllers.delete(requestId);
        // Drain any permission prompts that were never answered (otherwise
        // their pending entries leak across requests).
        for (const id of openPermissions) {
          denyPending(id, "Stream ended without a decision");
        }
        openPermissions.clear();
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by upstream — nothing to do.
        }
      }
    },
  });

  return c.newResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function handleAbortRequest(c: Context) {
  const requestId = c.req.param("requestId");
  if (!requestId) return c.json({ success: false }, 400);
  const success = abortRequest(requestId);
  return c.json({ success });
}
