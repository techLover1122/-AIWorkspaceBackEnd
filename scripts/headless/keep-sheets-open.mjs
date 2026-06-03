/**
 * Headless co-editor session for sheets-agent (port 4101).
 *
 * Mirror of keep-docs-open.mjs — opens Employees.xlsx in a headless
 * Chromium and keeps the editor + ai-agent-bridge plugin connected so
 * MCP `sheets_*` tools work without the user having the tab open.
 *
 *   docker exec -d -w /work/playwright/docs-test ai-ide-playwright \
 *     bash -lc 'node keep-sheets-open.mjs > /tmp/keep-sheets-open.log 2>&1'
 *
 * Override URL via env:
 *
 *   DOC_URL='https://…/edit?fileId=…&type=xlsx&name=…' node keep-sheets-open.mjs
 */
import { chromium } from "playwright";

// Required via env; see keep-docs-open.mjs for rationale.
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
await page.waitForSelector("iframe", { timeout: 60_000 });
console.log("editor iframe attached — holding session open");

const shutdown = async (sig) => {
  console.log("got", sig, "— closing browser");
  try { await browser.close(); } catch (_) {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
setInterval(() => console.log("alive", new Date().toISOString()), 60_000);
await new Promise(() => {});
