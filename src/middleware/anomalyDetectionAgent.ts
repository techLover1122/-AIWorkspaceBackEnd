import { info, warn } from "../utils/logger.js";
import type { CapturedIntent } from "./intentGuardAgent.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutedAction {
  toolName: string;
  input: Record<string, unknown>;
  /** Result text (first 500 chars) — used to detect unexpected side effects */
  resultSummary?: string;
  isError?: boolean;
}

export interface AnomalyCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
}

export interface AnomalyAlertPayload {
  severity: "none" | "low" | "high";
  summary: string;
  checks: AnomalyCheck[];
  capturedIntent?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check 1: Operation type drift
 * User's captured intent said "read" but agent ran write/delete tools.
 */
function checkOperationTypeDrift(
  capturedIntent: CapturedIntent,
  actions: ExecutedAction[]
): AnomalyCheck {
  if (capturedIntent.operationType === "unknown" || capturedIntent.operationType === "mixed") {
    return { name: "Operation type", status: "pass" };
  }

  const writePatterns = /\b(update|insert|delete|drop|truncate|create|alter|write|modify|rm|del\s)/i;
  const hasUnexpectedWrite = actions.some(
    (a) =>
      capturedIntent.operationType === "read" &&
      writePatterns.test(JSON.stringify(a.input))
  );

  if (hasUnexpectedWrite) {
    return {
      name: "Operation type",
      status: "fail",
      detail: `User intended a READ operation but agent executed write/delete commands`,
    };
  }

  return { name: "Operation type", status: "pass" };
}

/**
 * Check 2: Scope drift
 * User confirmed "single" scope but agent ran mass operations.
 */
function checkScopeDrift(
  capturedIntent: CapturedIntent,
  actions: ExecutedAction[]
): AnomalyCheck {
  if (capturedIntent.scope === "unknown" || capturedIntent.scope === "all") {
    // "all" was explicitly confirmed — no drift possible
    return { name: "Scope", status: "pass" };
  }

  // Look for indicators that more records were affected than intended
  const massPatterns =
    /\b(UPDATE\s+\w+\s+SET\b(?!.*\bWHERE\b)|DELETE\s+FROM\s+\w+\s*;|TRUNCATE|DROP\s+TABLE)\b/i;

  const massFired = actions.some((a) => massPatterns.test(JSON.stringify(a.input)));

  if (massFired && capturedIntent.scope === "single") {
    return {
      name: "Scope",
      status: "fail",
      detail: `User chose single-record scope but agent ran a mass operation`,
    };
  }

  // Check result for high affected-rows count
  for (const action of actions) {
    if (!action.resultSummary) continue;
    const rowsMatch = action.resultSummary.match(/(\d+)\s+(rows?|records?)\s+(affected|updated|deleted)/i);
    if (rowsMatch && parseInt(rowsMatch[1]) > 10 && capturedIntent.scope === "single") {
      return {
        name: "Scope",
        status: "warn",
        detail: `${rowsMatch[1]} rows were affected but user intended a single-record operation`,
      };
    }
  }

  return { name: "Scope", status: "pass" };
}

/**
 * Check 3: Unexpected tool categories
 * Agent used a tool type that doesn't match the task at all.
 * E.g. user asked about salary data but agent ran file deletion.
 */
function checkUnexpectedToolCategories(actions: ExecutedAction[]): AnomalyCheck {
  const destructiveInContext: string[] = [];

  for (const action of actions) {
    const inputStr = JSON.stringify(action.input).toLowerCase();

    if (/\brm\s+-rf\b/.test(inputStr) || /drop\s+database/i.test(inputStr)) {
      destructiveInContext.push(action.toolName);
    }
  }

  if (destructiveInContext.length > 0) {
    return {
      name: "Unexpected destructive tools",
      status: "warn",
      detail: `Destructive operations detected: ${destructiveInContext.join(", ")}`,
    };
  }

  return { name: "Unexpected destructive tools", status: "pass" };
}

/**
 * Check 4: Task completeness
 * Final response mentions an error, TODO, or incomplete state.
 */
function checkTaskCompleteness(finalResponse: string): AnomalyCheck {
  const incompletePhrases = [
    /\bTODO\b/,
    /\bFIXME\b/,
    /\bi (could not|was unable to|failed to|couldn't)\b/i,
    /\b(error|exception)\s+(occurred|happened|was thrown)\b/i,
    /\bpartially (complete|done|finished)\b/i,
    /\bnot (yet |fully )?(implemented|complete|done|finished)\b/i,
  ];

  for (const phrase of incompletePhrases) {
    if (phrase.test(finalResponse)) {
      return {
        name: "Task completeness",
        status: "warn",
        detail: `Response suggests the task may be incomplete or encountered an error`,
      };
    }
  }

  return { name: "Task completeness", status: "pass" };
}

/**
 * Check 5: Tool errors
 * Any tool ran but returned an error — agent may have silently failed.
 */
function checkToolErrors(actions: ExecutedAction[]): AnomalyCheck {
  const errored = actions.filter((a) => a.isError);
  if (errored.length > 0) {
    return {
      name: "Tool errors",
      status: "warn",
      detail: `${errored.length} tool(s) returned errors: ${errored.map((a) => a.toolName).join(", ")}`,
    };
  }
  return { name: "Tool errors", status: "pass" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs after all tool calls complete. Compares executed actions against
 * the CapturedIntent (if available) and returns an anomaly report.
 *
 * Returns severity "none" if everything looks fine — caller should NOT
 * push an anomaly_alert event in that case (stay silent).
 */
export function runAnomalyDetection(
  capturedIntent: CapturedIntent | null,
  actions: ExecutedAction[],
  finalResponse: string
): AnomalyAlertPayload {
  const checks: AnomalyCheck[] = [];

  // Run intent-based checks only if Intent Guard captured something
  if (capturedIntent) {
    checks.push(checkOperationTypeDrift(capturedIntent, actions));
    checks.push(checkScopeDrift(capturedIntent, actions));
  }

  // Always run these checks regardless of captured intent
  checks.push(checkUnexpectedToolCategories(actions));
  checks.push(checkTaskCompleteness(finalResponse));
  checks.push(checkToolErrors(actions));

  // Determine overall severity
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");

  let severity: "none" | "low" | "high";
  let summary: string;

  if (hasFail) {
    severity = "high";
    const failedChecks = checks.filter((c) => c.status === "fail");
    summary = failedChecks.map((c) => c.detail ?? c.name).join("; ");
    warn("AnomalyDetection HIGH severity:", { summary, checks });
  } else if (hasWarn) {
    severity = "low";
    const warnChecks = checks.filter((c) => c.status === "warn");
    summary = warnChecks.map((c) => c.detail ?? c.name).join("; ");
    info("AnomalyDetection LOW severity:", { summary, checks });
  } else {
    severity = "none";
    summary = "All checks passed";
    info("AnomalyDetection: clean", { actionCount: actions.length });
  }

  return {
    severity,
    summary,
    checks,
    capturedIntent: capturedIntent?.clarifiedIntent,
  };
}
