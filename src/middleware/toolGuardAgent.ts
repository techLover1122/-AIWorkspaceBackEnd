import { info } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolGuardVerdict = "allow" | "confirm";

export interface ToolGuardAssessment {
  verdict: ToolGuardVerdict;
  reason: string;
  impactCategory: ImpactCategory;
  /** Human-readable summary shown in the confirmation modal */
  actionSummary: string;
}

export type ImpactCategory =
  | "inherently_high_impact" // financial, legal, government — always confirm
  | "mass_destructive"       // bulk delete/drop — scale-based confirm
  | "mass_write"             // bulk update without tight filter
  | "mass_external"          // bulk emails, notifications
  | "routine";               // reads, small writes — always allow

// ─────────────────────────────────────────────────────────────────────────────
// Session history — tracks approved high-impact actions per task
// ─────────────────────────────────────────────────────────────────────────────

export interface ApprovedHighImpactEntry {
  toolName: string;
  actionSummary: string;
  impactCategory: ImpactCategory;
  approvedAt: number;
  /** Rough scale snapshot so we can detect dramatic scope jumps */
  estimatedScale: "single" | "few" | "many" | "all" | "unknown";
}

export type SessionHistory = ApprovedHighImpactEntry[];

export function createSessionHistory(): SessionHistory {
  return [];
}

export function recordApproval(
  history: SessionHistory,
  toolName: string,
  assessment: ToolGuardAssessment,
  scale: ApprovedHighImpactEntry["estimatedScale"]
): void {
  history.push({
    toolName,
    actionSummary: assessment.actionSummary,
    impactCategory: assessment.impactCategory,
    approvedAt: Date.now(),
    estimatedScale: scale,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Category 1 — Inherently High-Impact (description-based, scale irrelevant)
// These are ALWAYS confirmed regardless of how many records are affected.
// Detection is done by matching against the tool name + description.
// ─────────────────────────────────────────────────────────────────────────────

const INHERENTLY_HIGH_IMPACT_PATTERNS: RegExp[] = [
  // Financial / money movement
  /\b(transfer|payment|pay|charge|debit|credit|wire|refund|payout|billing|stripe|paypal|invoice\s+send|collect)\b/i,
  // Government / legal / compliance
  /\b(tax|taxes|filing|file_tax|submit.*tax|government|compliance|legal|court|contract.*sign|sign.*contract|notary)\b/i,
  // Publishing / irreversible external actions
  /\b(publish|deploy.*production|push.*live|send.*blast|broadcast|announce)\b/i,
  // Account access / identity
  /\b(revoke.*access|delete.*account|close.*account|ban.*user|disable.*account)\b/i,
];

function isInherentlyHighImpact(toolName: string, toolDescription: string): boolean {
  const combined = `${toolName} ${toolDescription}`.toLowerCase();
  return INHERENTLY_HIGH_IMPACT_PATTERNS.some((p) => p.test(combined));
}

// ─────────────────────────────────────────────────────────────────────────────
// Category 2 — Scale-dependent (input-based analysis)
// ─────────────────────────────────────────────────────────────────────────────

/** Detects mass destructive operations in SQL / shell commands */
function detectMassDestructive(input: Record<string, unknown>): {
  detected: boolean;
  summary: string;
} {
  const inputStr = JSON.stringify(input).toLowerCase();

  // SQL: DELETE / TRUNCATE / DROP without a tight WHERE clause
  if (/drop\s+(table|database|schema)/i.test(inputStr)) {
    return { detected: true, summary: "DROP table/database — irreversible" };
  }
  if (/truncate\s+table/i.test(inputStr)) {
    return { detected: true, summary: "TRUNCATE table — removes all rows" };
  }
  // DELETE without WHERE (or very broad WHERE)
  if (/\bdelete\s+from\s+\w+\s*(?:;|$)/i.test(inputStr)) {
    return { detected: true, summary: "DELETE FROM without WHERE — deletes all rows" };
  }

  // Shell: destructive commands
  if (/\brm\s+-rf?\b/.test(inputStr)) {
    return { detected: true, summary: "rm -rf — recursive force delete" };
  }
  if (/\bformat\b/.test(inputStr) && /\b(disk|drive|volume|c:|d:)\b/i.test(inputStr)) {
    return { detected: true, summary: "disk format operation" };
  }
  if (/\bdel\s+\/[fs]/i.test(inputStr)) {
    return { detected: true, summary: "del /f /s — force recursive delete" };
  }

  return { detected: false, summary: "" };
}

/** Detects mass write operations (UPDATE without tight WHERE) */
function detectMassWrite(input: Record<string, unknown>): {
  detected: boolean;
  summary: string;
} {
  const inputStr = JSON.stringify(input).toLowerCase();

  // UPDATE without WHERE
  if (/\bupdate\s+\w+\s+set\b(?!.*\bwhere\b)/i.test(inputStr)) {
    return { detected: true, summary: "UPDATE without WHERE — modifies all rows" };
  }

  // UPDATE with very broad WHERE (no primary-key-style filter)
  if (
    /\bupdate\s+\w+\s+set\b.*\bwhere\b/i.test(inputStr) &&
    !/\bwhere\s+\w+\s*(=|in\s*\()\s*\d+/i.test(inputStr) &&
    !/\bwhere\s+id\b/i.test(inputStr)
  ) {
    return { detected: true, summary: "UPDATE with broad WHERE — may affect many rows" };
  }

  return { detected: false, summary: "" };
}

/** Detects bulk external actions (mass emails, notifications) */
function detectMassExternal(
  toolName: string,
  toolDescription: string,
  input: Record<string, unknown>
): { detected: boolean; summary: string } {
  const combined = `${toolName} ${toolDescription}`.toLowerCase();
  const inputStr = JSON.stringify(input).toLowerCase();

  if (/\b(email|notify|notification|sms|message|alert)\b/.test(combined)) {
    // Check if recipient count hints at bulk
    const countMatch = inputStr.match(/"count":\s*(\d+)/);
    if (countMatch && parseInt(countMatch[1]) > 50) {
      return { detected: true, summary: `Bulk ${toolName} to ${countMatch[1]} recipients` };
    }
    if (/\ball\s+users\b|\beveryone\b|\bbulk\b/.test(inputStr)) {
      return { detected: true, summary: `Bulk ${toolName} to all users` };
    }
  }

  return { detected: false, summary: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routine allow-list — tools that are NEVER high-impact
// ─────────────────────────────────────────────────────────────────────────────

const ALWAYS_ALLOW_PATTERNS: RegExp[] = [
  /^(read|list|get|fetch|search|find|show|view|describe|explain|check|inspect|scan|query|select)/i,
  /^mcp__aiide__(list|scan|open_tab|add_bookmark|list_bookmarks)/i,
  /\b(read_file|list_directory|glob|grep|bash_get|status)\b/i,
];

function isRoutineTool(toolName: string, toolDescription: string): boolean {
  const combined = `${toolName} ${toolDescription}`;
  return ALWAYS_ALLOW_PATTERNS.some((p) => p.test(combined));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main assess function — called from canUseTool in chat.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assesses whether a tool call should be auto-allowed or presented to the
 * user for confirmation. Completely stateless — does not access conversation.
 *
 * @param toolName        SDK tool name (e.g. "Bash", "mcp__aiide__open_tab")
 * @param toolDescription Tool description string from SDK options
 * @param input           Actual input values for this call
 */
export function assessTool(
  toolName: string,
  toolDescription: string,
  input: Record<string, unknown>
): ToolGuardAssessment {
  // 1. Quick allow-list check — read-only / harmless tools
  if (isRoutineTool(toolName, toolDescription)) {
    return {
      verdict: "allow",
      reason: "Routine read-only tool",
      impactCategory: "routine",
      actionSummary: toolName,
    };
  }

  // 2. Inherently high-impact — tool nature requires confirmation always
  if (isInherentlyHighImpact(toolName, toolDescription)) {
    info("ToolGuard inherently-high-impact:", { toolName });
    return {
      verdict: "confirm",
      reason: "This tool performs financial, legal, or irreversible external actions",
      impactCategory: "inherently_high_impact",
      actionSummary: `${toolName}: ${toolDescription.slice(0, 100)}`,
    };
  }

  // 3. Mass destructive — scale-dependent
  const massDestructive = detectMassDestructive(input);
  if (massDestructive.detected) {
    info("ToolGuard mass-destructive detected:", { toolName, summary: massDestructive.summary });
    return {
      verdict: "confirm",
      reason: massDestructive.summary,
      impactCategory: "mass_destructive",
      actionSummary: massDestructive.summary,
    };
  }

  // 4. Mass write — scale-dependent
  const massWrite = detectMassWrite(input);
  if (massWrite.detected) {
    info("ToolGuard mass-write detected:", { toolName, summary: massWrite.summary });
    return {
      verdict: "confirm",
      reason: massWrite.summary,
      impactCategory: "mass_write",
      actionSummary: massWrite.summary,
    };
  }

  // 5. Bulk external — scale-dependent
  const massExternal = detectMassExternal(toolName, toolDescription, input);
  if (massExternal.detected) {
    info("ToolGuard mass-external detected:", { toolName, summary: massExternal.summary });
    return {
      verdict: "confirm",
      reason: massExternal.summary,
      impactCategory: "mass_external",
      actionSummary: massExternal.summary,
    };
  }

  // 6. Default — allow (small-scale writes are fine without interruption)
  return {
    verdict: "allow",
    reason: "Normal-scale operation",
    impactCategory: "routine",
    actionSummary: toolName,
  };
}
