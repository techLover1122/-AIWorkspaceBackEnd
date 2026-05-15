import { Context } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { debug as logDebug } from "../utils/logger.js";
import { detectAuthMethod, getMaskedApiKey } from "./auth.js";

const execFileAsync = promisify(execFile);

/**
 * GET /api/status — reports whether the backend can use Claude right now.
 *
 * Two checks are reported separately so the frontend can give precise
 * guidance:
 *   - cli: the `claude` binary exists and responds to --version
 *   - auth: either an in-memory API key OR a CLI-stored subscription token
 *
 * `connected` is true only when BOTH are true.
 */
export async function handleStatusRequest(c: Context) {
  const cliPath = process.env.CLAUDE_PATH;
  const authMethod = detectAuthMethod();

  if (!cliPath) {
    return c.json({
      connected: false,
      reason: "cli_not_found",
      cliReady: false,
      authMethod,
      message:
        "Claude CLI not detected. Install with: npm install -g @anthropic-ai/claude-code",
    });
  }

  let version: string | undefined;
  let cliReady = false;
  try {
    const { stdout } = await execFileAsync(cliPath, ["--version"], {
      timeout: 5000,
    });
    version = stdout.trim();
    cliReady = true;
  } catch (err) {
    logDebug(`/api/status cli_error: ${err instanceof Error ? err.message : err}`);
    return c.json({
      connected: false,
      reason: "cli_error",
      cliReady: false,
      authMethod,
      cliPath,
      message:
        err instanceof Error ? err.message : "Claude CLI failed to respond",
    });
  }

  if (!authMethod) {
    return c.json({
      connected: false,
      reason: "auth_missing",
      cliReady,
      authMethod: null,
      cliPath,
      version,
      message:
        "No authentication found. Sign in via subscription, API key, or cloud provider.",
    });
  }

  return c.json({
    connected: true,
    cliReady,
    authMethod,
    cliPath,
    version,
    apiKeyMasked: authMethod === "api_key" ? getMaskedApiKey() : null,
  });
}
