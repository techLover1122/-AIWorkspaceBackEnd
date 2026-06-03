/**
 * Headless co-editor session for docs-agent (port 4100).
 *
 * Opens Document.docx in a headless Chromium and keeps the editor +
 * ai-agent-bridge plugin connected indefinitely — the "Phase 5 follow-up
 * Playwright headless co-editor" hinted at in src/agent.ts. With this
 * running, MCP `docs_*` tools work even when the user has no browser tab
 * open on Document.docx.
 *
 * Designed to run inside the ai-ide-playwright container where
 * Chromium + Playwright are pre-installed:
 *
 *   docker exec -d -w /work/playwright/docs-test ai-ide-playwright \
 *     bash -lc 'node keep-docs-open.mjs > /tmp/keep-docs-open.log 2>&1'
 *
 * Override the URL via env if you point this at a different doc/host:
 *
 *   DOC_URL='https://…/edit?fileId=…&type=docx&name=…' node keep-docs-open.mjs
 *
 * Exits cleanly on SIGTERM / SIGINT; wrap with systemd or supervisord
 * if you need restart-on-crash.
 */
import { chromium } from "playwright";

// Hard requirement: the boot recipe (scripts/recipes/headless-coeditors.sh)
// constructs the URL from /etc/workspace.env and passes it via -e DOC_URL.
// Failing fast here keeps a stale user-id from being baked into a recipe
// that gets cloned to another workspace.
const URL = process.env.DOC_URL;
if (!URL) {
  console.error("DOC_URL env var is required (set by headless-coeditors.sh)");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on("console", (m) => console.log(`[page:${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

console.log("opening", URL);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

// Wait for the ONLYOFFICE editor iframe to appear. We don't have a
// clean "plugin connected" signal in-page, so we just hold the tab open
// and let the WebSocket reconnect loop in plugin.js do its job.
await page.waitForSelector("iframe", { timeout: 60_000 });
console.log("editor iframe attached — holding session open");

const shutdown = async (sig) => {
  console.log("got", sig, "— closing browser");
  try { await browser.close(); } catch (_) {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Heartbeat so the log file shows progress.
setInterval(() => console.log("alive", new Date().toISOString()), 60_000);

// Hold the process open forever.
await new Promise(() => {});
