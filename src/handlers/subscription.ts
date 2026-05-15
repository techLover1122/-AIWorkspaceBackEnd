import { Context } from "hono";
import * as pty from "node-pty";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { info, debug as logDebug, error as logError, warn } from "../utils/logger.js";

/**
 * Spawned-CLI subscription login using a real pseudo-TTY.
 *
 * We use `claude auth login --claudeai` (NOT bare `claude login`) — the
 * `--claudeai` flag selects the Claude subscription provider directly, so
 * the CLI skips its "Select login method" menu entirely. Only the theme
 * picker remains (and only on first ever CLI launch), which our state
 * machine + pre-stuffed Enters auto-confirm.
 *
 * The Claude CLI refuses to render its sign-in flow when stdin isn't a TTY,
 * so we use `node-pty` (ConPTY on Windows / openpty on POSIX) to give it
 * the terminal semantics it expects.
 */

type Phase =
  | "idle"
  | "spawning"
  | "waiting_url"
  | "browser_opened"
  | "success"
  | "no_subscription"
  | "error"
  | "cancelled";

interface SubscriptionState {
  phase: Phase;
  url: string | null;
  urls: string[];
  error: string | null;
  startedAt: number | null;
  process: pty.IPty | null;
  output: string;
}

const URL_PATTERN =
  /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|auth\.anthropic\.com|platform\.claude\.com)\/[^\s]+/;

const SUCCESS_HINTS = [
  /logged in/i,
  /login successful/i,
  /authentication.+success/i,
  /you'?re signed in/i,
  /successfully (?:logged|signed)/i,
  /auth(?:entication)? complete/i,
  /signed in (?:as|to|with)/i,
  /welcome to claude/i,
  /claude code (?:is )?ready/i,
  /credentials? (?:saved|stored)/i,
];

// Hints that mean "OAuth worked but this account doesn't have a paid
// Claude Code plan attached". Different CLI builds phrase this differently,
// so we keep a broad set.
const NO_SUBSCRIPTION_HINTS = [
  /no (?:active )?(?:claude(?:\s*code)?\s*)?subscription/i,
  /subscription (?:is )?required/i,
  /(?:upgrade|subscribe) to (?:pro|max|claude)/i,
  /claude code (?:is )?not (?:available|enabled) on (?:this|your) (?:plan|account)/i,
  /does(?:n'?t| not) have (?:an? )?(?:active )?(?:claude(?:\s*code)?\s*)?(?:subscription|plan)/i,
  /free (?:tier|plan).*(?:not|cannot|doesn'?t)/i,
  /please subscribe/i,
];

// Patterns that identify which screen the CLI is showing. Theme picker has
// varied across CLI versions — older builds say "Choose your theme" with
// dark/light/daltonized options; newer builds show "Syntax theme: Monokai
// Extended (ctrl+t to disable)" with a live code preview. Be lenient.
const THEME_MENU_PATTERN =
  /(syntax theme|monokai extended|ctrl\+t to disable|choose.*(theme|text style|appearance)|select.*theme|color theme|terminal appearance|dark mode|light mode|daltonized)/i;
const LOGIN_METHOD_PATTERN =
  /(select login method|claude account with subscription|anthropic console account|3rd-party platform)/i;
// Anything that proves the CLI has actually started rendering output.
const CLI_READY_PATTERN = /welcome to|claude code v?\d+\.\d+/i;

type MenuStep = "theme" | "login_method" | "url";

let current: SubscriptionState = {
  phase: "idle",
  url: null,
  urls: [],
  error: null,
  startedAt: null,
  process: null,
  output: "",
};

function reset(): void {
  current = {
    phase: "idle",
    url: null,
    urls: [],
    error: null,
    startedAt: null,
    process: null,
    output: "",
  };
}

function isTerminal(phase: Phase): boolean {
  return (
    phase === "idle" ||
    phase === "success" ||
    phase === "no_subscription" ||
    phase === "error" ||
    phase === "cancelled"
  );
}

function createNoBrowserEnv(): Record<string, string> {
  const extra: Record<string, string> = {
    BROWSER: "none",
    DISPLAY: "",
    // Do NOT set CI=true — it disables the CLI's server-side polling loop
    // that waits for the OAuth callback to arrive at platform.claude.com.
  };
  try {
    const tmpDir = path.join(os.tmpdir(), "aiide-nobrowser");
    fs.mkdirSync(tmpDir, { recursive: true });
    if (process.platform === "win32") {
      const stub = path.join(tmpDir, "start.cmd");
      if (!fs.existsSync(stub)) {
        fs.writeFileSync(stub, "@echo off\r\nexit /b 0\r\n", "utf8");
      }
      extra.PATH = `${tmpDir};${process.env.PATH ?? ""}`;
      extra.BROWSER = stub;
    } else {
      const stub = path.join(tmpDir, "noop-browser");
      if (!fs.existsSync(stub)) {
        fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", "utf8");
        fs.chmodSync(stub, 0o755);
      }
      extra.PATH = `${tmpDir}:${process.env.PATH ?? ""}`;
      extra.BROWSER = stub;
    }
  } catch (err) {
    warn(`createNoBrowserEnv: stub write failed (${err instanceof Error ? err.message : err}), env-only fallback active.`);
  }
  return extra;
}

/**
 * Post-login probe via `claude auth status --json`. Non-billable, no model
 * call — just inspects the local credentials store. If the JSON reports no
 * active subscription (free tier / no plan / Console API key only), we flip
 * shared state to `no_subscription` so the UI can show the upgrade prompt.
 *
 * Other failures (binary missing, timeout, malformed JSON) are swallowed —
 * we'll discover the problem naturally when the user actually chats.
 */
async function verifySubscriptionUsable(): Promise<void> {
  const claudePath = process.env.CLAUDE_PATH;
  if (!claudePath) return;
  if (current.phase !== "success") return;

  try {
    const child = pty.spawn(
      claudePath,
      ["auth", "status", "--json"],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      }
    );
    let buf = "";
    child.onData((d: string) => {
      buf += d;
    });
    const exitCode: number = await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(-1);
      }, 10_000);
      child.onExit(({ exitCode: code }) => {
        clearTimeout(killTimer);
        resolve(code);
      });
    });

    const plain = stripAnsi(buf);
    logDebug(`auth status raw output (exit ${exitCode}): ${plain.slice(0, 500)}`);

    // Try to parse JSON — CLI may wrap it in extra whitespace / ANSI noise.
    const jsonMatch = plain.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logDebug("auth status: no JSON object found in output, skipping verify.");
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      logDebug("auth status: JSON parse failed, skipping verify.");
      return;
    }

    // Look at a few candidate fields the CLI might use. The exact schema
    // varies by CLI version — we accept any of these as a "has subscription"
    // signal: a non-empty subscription/plan/tier field that isn't "free".
    const blob = JSON.stringify(parsed).toLowerCase();
    const looksFree = /"(subscription|plan|tier|account_?type)"\s*:\s*("?(free|none|null|inactive)"?|null)/.test(
      blob
    );
    const hasPaidMarker = /"(pro|max|team|enterprise|active|claudeai|subscribed)"/.test(
      blob
    );
    const explicitNoSub = /"(has_?subscription|subscription_?active)"\s*:\s*false/.test(
      blob
    );

    if ((looksFree || explicitNoSub) && !hasPaidMarker && current.phase === "success") {
      current.phase = "no_subscription";
      current.error =
        "Sign-in succeeded, but this account doesn't have an active Claude Code subscription yet.";
      current.output = plain.slice(-2000);
      info("auth status probe: account has no active Claude Code plan.");
    } else {
      logDebug("auth status probe: subscription looks active.");
    }
  } catch (err) {
    logDebug(
      `auth status probe skipped: ${err instanceof Error ? err.message : err}`
    );
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export async function handleStartSubscription(c: Context) {
  if (!isTerminal(current.phase)) {
    return c.json({
      phase: current.phase,
      url: current.url,
      urls: current.urls,
      error: current.error,
      output: current.output,
    });
  }

  const claudePath = process.env.CLAUDE_PATH;
  if (!claudePath) {
    return c.json(
      {
        phase: "error" satisfies Phase,
        url: null,
        urls: [],
        error: "Claude CLI not detected on the backend.",
        output: "",
      },
      400
    );
  }

  reset();
  current.phase = "spawning";
  current.startedAt = Date.now();
  info("Spawning `claude auth login --claudeai` inside a PTY…");

  let outputBuf = "";
  let urlHandled = false;
  let menuStep: MenuStep = "theme";
  let lastEnterAt = 0;
  let pressedForTheme = false;
  let pressedForLogin = false;
  let cliReadyAt: number | null = null;
  let lastDataAt = Date.now();
  let proc: pty.IPty;

  try {
    proc = pty.spawn(claudePath, ["auth", "login", "--claudeai"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, ...createNoBrowserEnv() } as Record<string, string>,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("pty.spawn failed:", msg);
    current.phase = "error";
    current.error = `Could not spawn PTY for claude login: ${msg}`;
    return c.json(
      {
        phase: current.phase,
        url: null,
        error: current.error,
        output: "",
      },
      500
    );
  }

  current.process = proc;
  current.phase = "waiting_url";

  const captureOutput = (): void => {
    current.output = stripAnsi(outputBuf).slice(-2000);
  };

  const tryExtractUrl = (): void => {
    const plain = stripAnsi(outputBuf);
    const urlRe = /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|auth\.anthropic\.com|platform\.claude\.com)\/[^\s\r\n)>\]"]+/g;
    const matches = [...plain.matchAll(urlRe)];
    if (matches.length === 0) return;
    const allUrls = [...new Set(matches.map((m) => m[0].replace(/[)\].,]+$/, "")))];
    if (allUrls.length === current.urls.length) return;
    current.urls = allUrls;
    // Last URL is typically the "direct key" URL the user wants
    current.url = allUrls[allUrls.length - 1];
    if (!urlHandled) {
      urlHandled = true;
      current.phase = "browser_opened";
      logDebug(`OAuth URLs detected (${allUrls.length}): ${allUrls.join(" | ")}`);
    }
  };

  const checkSuccessText = (): void => {
    if (current.phase === "success" || current.phase === "no_subscription") return;
    const plain = stripAnsi(outputBuf);
    if (NO_SUBSCRIPTION_HINTS.some((re) => re.test(plain))) {
      current.phase = "no_subscription";
      current.error =
        "Sign-in succeeded, but this account doesn't have an active Claude Code subscription yet.";
      return;
    }
    if (SUCCESS_HINTS.some((re) => re.test(plain))) {
      current.phase = "success";
    }
  };

  const sawNoSubscriptionHint = (): boolean => {
    const plain = stripAnsi(outputBuf);
    return NO_SUBSCRIPTION_HINTS.some((re) => re.test(plain));
  };

  // Send Enter, but never faster than ~350ms apart — back-to-back writes
  // can be swallowed by the CLI while it's redrawing the next screen.
  // We use info() so the line is visible without the DEBUG env var — this
  // is critical for diagnosing menu detection failures in the field.
  const pressEnter = (note: string): void => {
    const now = Date.now();
    if (now - lastEnterAt < 350) return;
    lastEnterAt = now;
    try {
      proc.write("\r");
      info(`[claude login] Enter sent: ${note}`);
    } catch {
      /* ignore */
    }
  };

  // Single funnel for "advance past the login-method menu". Both the
  // pattern-detection path and the time-based fallback call this — whichever
  // fires first wins, and the flag prevents a duplicate press.
  const advanceLogin = (reason: string): void => {
    if (pressedForLogin || urlHandled || menuStep === "url") return;
    pressedForLogin = true;
    menuStep = "url";
    pressEnter(`confirm Subscription [${reason}]`);
  };

  const driveMenus = (): void => {
    if (urlHandled || menuStep === "url") return;
    const plain = stripAnsi(outputBuf);

    if (menuStep === "theme") {
      // Skip-theme path: login menu showing first (theme already chosen).
      if (LOGIN_METHOD_PATTERN.test(plain)) {
        menuStep = "login_method";
      } else if (THEME_MENU_PATTERN.test(plain) && !pressedForTheme) {
        pressedForTheme = true;
        pressEnter("confirm theme (first highlighted)");
        menuStep = "login_method";
        // Time-based fallback: even if LOGIN_METHOD_PATTERN never matches
        // (CLI text drifted), still advance after a fixed delay. The CLI
        // typically renders the auth menu within 300-500ms of confirming
        // the theme, so 700ms is a safe upper bound.
        setTimeout(() => advanceLogin("post-theme timer"), 700);
      }
    }

    if (menuStep === "login_method" && LOGIN_METHOD_PATTERN.test(plain)) {
      advanceLogin("pattern match");
    }
  };

  // Once the CLI prints something substantive, start watching for idle
  // periods. An "idle" window (no new data for ~900ms) after a screen
  // change usually means the CLI is waiting for input — that's our cue
  // to nudge if pattern detection missed.
  const checkCliReady = (): void => {
    if (cliReadyAt !== null) return;
    const plain = stripAnsi(outputBuf);
    if (CLI_READY_PATTERN.test(plain) || plain.trim().length > 200) {
      cliReadyAt = Date.now();
      logDebug("CLI ready signal detected, starting idle-nudge watcher");
      scheduleIdleNudge();
    }
  };

  const scheduleIdleNudge = (): void => {
    const check = (): void => {
      if (current.process !== proc) return;
      if (urlHandled || menuStep === "url") return;

      const idleFor = Date.now() - lastDataAt;
      if (idleFor < 900) {
        // CLI still actively rendering; check again shortly.
        setTimeout(check, 300);
        return;
      }
      // CLI has been quiet for ~900ms — it's waiting for input.
      if (!pressedForTheme) {
        pressedForTheme = true;
        pressEnter("idle-nudge: theme menu");
        menuStep = "login_method";
        setTimeout(check, 800); // Keep watching for the login screen
      } else if (!pressedForLogin) {
        advanceLogin("idle-nudge: login menu");
      }
    };
    setTimeout(check, 900);
  };

  proc.onData((data: string) => {
    outputBuf += data;
    lastDataAt = Date.now();
    // Always log PTY output after URL is captured so we can see the code-entry prompt
    if (urlHandled || process.env.DEBUG) {
      logDebug(`[pty] ${stripAnsi(data).replace(/\r?\n/g, "⏎").slice(0, 200)}`);
    }
    tryExtractUrl();
    checkSuccessText();
    driveMenus();
    checkCliReady();
    captureOutput();
  });

  // Absolute last-resort nudge: if the CLI hasn't even printed a "welcome"
  // marker by 8 seconds, send a blind Enter pair anyway. This covers really
  // exotic CLI builds that print nothing recognisable.
  setTimeout(() => {
    if (current.process !== proc || urlHandled) return;
    if (cliReadyAt !== null) return; // idle-nudge is handling it
    if (!pressedForTheme) {
      pressedForTheme = true;
      pressEnter("last-resort: blind theme");
      setTimeout(() => advanceLogin("last-resort: blind login"), 700);
    }
  }, 8000);

  // ------------------------------------------------------------------
  // PRE-STUFF stdin: bypass mechanism that doesn't depend on parsing the
  // CLI's output at all. We queue Enter keystrokes into the PTY at fixed
  // times after spawn — the CLI's stdin buffer holds them, and as each
  // interactive menu becomes ready the CLI consumes one Enter (selecting
  // the highlighted default). This is what gets us through both the theme
  // and login-method menus regardless of CLI version text drift.
  //
  // The state-machine logic above still runs and short-circuits these if
  // it gets there first — pre-stuff is the safety net, not the primary
  // path. Once an OAuth URL is seen we stop queueing keystrokes so we
  // don't accidentally confirm a later prompt.
  // ------------------------------------------------------------------
  const PRE_STUFF_DELAYS_MS = [300, 1100, 1900];
  for (const delay of PRE_STUFF_DELAYS_MS) {
    setTimeout(() => {
      if (current.process !== proc) return;
      if (urlHandled || menuStep === "url") return;
      try {
        proc.write("\r");
        info(`[claude login] Pre-stuff Enter (t=${delay}ms)`);
        lastEnterAt = Date.now();
      } catch {
        /* ignore */
      }
    }, delay);
  }

  proc.onExit(({ exitCode, signal }) => {
    captureOutput();
    if (current.process !== proc) return;
    current.process = null;

    // Preserve cancelled / error / no_subscription states already set.
    if (
      current.phase === "cancelled" ||
      current.phase === "error" ||
      current.phase === "no_subscription"
    ) {
      return;
    }

    // Even on exit code 0, do one last scan — some CLI builds print the
    // "no subscription" notice and then exit cleanly.
    if (sawNoSubscriptionHint()) {
      current.phase = "no_subscription";
      current.error =
        "Sign-in succeeded, but this account doesn't have an active Claude Code subscription yet.";
      info("Claude login completed but no active subscription detected.");
      return;
    }

    if (exitCode === 0) {
      current.phase = "success";
      info("Claude login succeeded.");
      // Verify subscription is actually usable in the background; if not,
      // flip phase to no_subscription so the UI can warn the user.
      void verifySubscriptionUsable();
      return;
    }

    current.phase = "error";
    const tail = stripAnsi(outputBuf).trim().slice(-500);
    current.error =
      `claude login exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""}.` +
      (tail ? `\nLast output:\n${tail}` : " (no output captured)");
    warn(current.error);
  });

  // Hard 5-minute timeout — user needs time to sign in.
  setTimeout(
    () => {
      if (current.phase === "browser_opened" || current.phase === "waiting_url") {
        captureOutput();
        const tail = stripAnsi(outputBuf).trim().slice(-500);
        current.phase = "error";
        current.error =
          `Timed out after 5 minutes waiting for sign-in.` +
          (tail ? `\nLast CLI output:\n${tail}` : "");
        if (current.process && current.process === proc) {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
        }
      }
    },
    5 * 60 * 1000
  );

  return c.json({
    phase: current.phase,
    url: current.url,
    urls: current.urls,
    error: current.error,
    output: current.output,
  });
}

export async function handleSubscriptionStatus(c: Context) {
  return c.json({
    phase: current.phase,
    url: current.url,
    urls: current.urls,
    error: current.error,
    output: current.output,
  });
}

export async function handleSubmitSubscriptionCode(c: Context) {
  const body = await c.req.json<{ code: string }>();
  const rawCode = (body.code ?? "").trim();
  if (!rawCode) {
    return c.json({ ok: false, error: "No code provided." }, 400);
  }

  // Strategy A — if the user pasted the full redirect URL (e.g. the browser's
  // address bar after auth failed to redirect), fetch it directly so the
  // CLI's local callback server handles it.
  if (rawCode.startsWith("http://") || rawCode.startsWith("https://")) {
    try {
      await fetch(rawCode, { signal: AbortSignal.timeout(6_000) });
      info("[claude login] Redirect URL fetched by submit-code endpoint.");
      return c.json({ ok: true });
    } catch (err) {
      info(`[claude login] Redirect URL fetch failed: ${err instanceof Error ? err.message : err}. Falling through to code-only path.`);
    }
  }

  // Strategy B — user pasted only the authorization code; reconstruct the
  // redirect URI from the stored auth URL and hit the CLI's local server.
  const authUrl = current.urls[0] ?? current.url;
  if (authUrl) {
    try {
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get("redirect_uri");
      if (redirectUri && redirectUri.startsWith("http://localhost")) {
        const callbackUrl = new URL(redirectUri);
        callbackUrl.searchParams.set("code", rawCode);
        const state = parsed.searchParams.get("state");
        if (state) callbackUrl.searchParams.set("state", state);
        await fetch(callbackUrl.toString(), { signal: AbortSignal.timeout(6_000) });
        info(`[claude login] Callback fetched: ${callbackUrl.toString().slice(0, 80)}`);
        return c.json({ ok: true });
      }
    } catch (err) {
      info(`[claude login] Callback fetch failed: ${err instanceof Error ? err.message : err}. Trying stdin.`);
    }
  }

  // Strategy C — last resort: write code to PTY stdin.
  if (current.process) {
    try {
      current.process.write(rawCode + "\r");
      info("[claude login] Authorization code written to PTY stdin.");
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : "Failed to submit code." },
        500
      );
    }
  }

  return c.json({ ok: false, error: "No active login session." }, 400);
}

export async function handleCancelSubscription(c: Context) {
  if (current.process) {
    current.phase = "cancelled";
    try {
      current.process.kill();
    } catch {
      /* ignore */
    }
    info("Subscription login cancelled by user.");
  } else {
    reset();
  }
  return c.json({ ok: true, phase: current.phase });
}
