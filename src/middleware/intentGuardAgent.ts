import { randomUUID } from "node:crypto";
import { info } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CapturedIntent {
  originalMessage: string;
  /** Human-readable summary of what the user actually meant */
  clarifiedIntent: string;
  /** Which interpretation the user chose */
  choice: "narrow" | "broad" | "auto";
  /** Text injected at the start of the prompt to steer the agent */
  promptPrefix: string;
  operationType: "read" | "write" | "delete" | "mixed" | "unknown";
  scope: "single" | "few" | "many" | "all" | "unknown";
  timestamp: number;
}

export interface IntentGuardOption {
  key: "narrow" | "broad";
  label: string;
  /** Appended to user prompt so agent follows the chosen interpretation */
  promptPrefix: string;
  isLargeScale: boolean;
  estimatedScope?: string;
}

export interface IntentGuardRequestPayload {
  id: string;
  originalMessage: string;
  question: string;
  narrowOption: IntentGuardOption;
  broadOption: IntentGuardOption;
}

type PendingIntentGuard = {
  resolve: (choice: "narrow" | "broad") => void;
  payload: IntentGuardRequestPayload;
  createdAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// In-memory pending map (same pattern as permission bridge)
// ─────────────────────────────────────────────────────────────────────────────

const pending = new Map<string, PendingIntentGuard>();

export function createPendingIntentGuard(payload: Omit<IntentGuardRequestPayload, "id">): {
  id: string;
  promise: Promise<"narrow" | "broad">;
} {
  const id = randomUUID();
  const fullPayload: IntentGuardRequestPayload = { ...payload, id };
  const promise = new Promise<"narrow" | "broad">((resolve) => {
    pending.set(id, { resolve, payload: fullPayload, createdAt: Date.now() });
  });
  return { id, promise };
}

export function resolveIntentGuard(id: string, choice: "narrow" | "broad"): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(choice);
  return true;
}

export function autoResolveIntentGuard(id: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  // Default to narrow (safe) on timeout
  entry.resolve("narrow");
  return true;
}

export function denyIntentGuard(id: string): boolean {
  return autoResolveIntentGuard(id);
}

export function isPendingIntentGuard(id: string): boolean {
  return pending.has(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ambiguity detection — pattern-based, no API call needed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known plural entity nouns that signal a potential mass-operation target.
 * Singular forms are intentionally excluded — "user" or "product" suggests
 * a specific target, "users" or "products" suggests a collection.
 */
const MASS_TARGET_NOUNS =
  /\b(users|products|orders|employees|records|items|accounts|invoices|entries|rows|documents|files|customers|transactions|payments|subscriptions|reports|logs)\b/i;

/**
 * Verbs that imply a write/mutate operation in ambiguous context.
 */
const WRITE_VERBS =
  /\b(update|change|set|delete|remove|edit|modify|reset|clear|disable|enable|block|unblock|archive|restore|migrate|move|assign|revoke|karo|badal|hata|delete|kar do|band karo|update karo)\b/i;

/**
 * Patterns that make the intent CLEAR (not ambiguous).
 * If any of these match, skip the Intent Guard modal.
 */
const CLEAR_INTENT_PATTERNS = [
  /\bid\s*[=:#]\s*\d+/i,                          // "id=5", "id: 42", "id #7"
  /\bwhere\b.{0,40}\b(=|is|equals)\b/i,           // SQL-like: "where status = active"
  /\bsirf\s+(ek|one|1)\b/i,                        // Urdu: "sirf ek"
  /\b(specific|particular|this|that|the)\s+\w+/i, // "this product", "the user"
  /\buser\s+#?\d+\b/i,                             // "user 42"
  /\b(get|show|fetch|find|search|list|read|query|dikhao|dekho|find)\b/i, // explicit read verbs
  /\ball\s+(of\s+them|records|users|products)/i,   // explicitly "all" — broad intent is clear
  /\btamam\b/i,                                    // Urdu for "all" — explicit
];

export interface AmbiguityAnalysis {
  isAmbiguous: boolean;
  entityNoun: string;
  narrowOption: IntentGuardOption;
  broadOption: IntentGuardOption;
  question: string;
}

export function analyzeAmbiguity(userMessage: string): AmbiguityAnalysis | null {
  const hasWriteVerb = WRITE_VERBS.test(userMessage);
  const massMatch = userMessage.match(MASS_TARGET_NOUNS);
  const hasMassNoun = massMatch !== null;

  // Must have both a write verb and a plural mass-target noun to be ambiguous
  if (!hasWriteVerb || !hasMassNoun) return null;

  // Check for clear-intent signals — if any match, skip the modal
  for (const pattern of CLEAR_INTENT_PATTERNS) {
    if (pattern.test(userMessage)) return null;
  }

  const noun = (massMatch[0] ?? "records").toLowerCase();
  // Derive a reasonable singular
  const singular = noun.endsWith("s") ? noun.slice(0, -1) : noun;

  // Detect what kind of write verb is being used
  const deleteVerb = /\b(delete|remove|hata|remove)\b/i.test(userMessage);
  const resetVerb = /\b(reset|clear)\b/i.test(userMessage);
  const actionWord = deleteVerb ? "delete" : resetVerb ? "reset" : "update";

  const narrowLabel = `Sirf ek specific ${singular} (query / find)`;
  const broadLabel = `Tamam ${noun} ${actionWord} karo`;

  return {
    isAmbiguous: true,
    entityNoun: noun,
    narrowOption: {
      key: "narrow",
      label: narrowLabel,
      promptPrefix: `[User clarified: They want to QUERY or find a specific ${singular} matching the criteria — NOT a bulk ${actionWord} on all ${noun}. Treat this as a read/search operation on a single targeted record.]`,
      isLargeScale: false,
    },
    broadOption: {
      key: "broad",
      label: broadLabel,
      promptPrefix: `[User clarified: They explicitly want to ${actionWord} ALL matching ${noun} — this is a bulk operation. Proceed with the full scope as requested.]`,
      isLargeScale: true,
      estimatedScope: `all ${noun}`,
    },
    question: `"${userMessage}" — aap ka kya matlab hai?`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point used by chat.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs before query(). If the message is unambiguous, returns null (no-op).
 * If ambiguous, creates a pending modal and returns a Promise that resolves
 * once the user picks an option. The resolved CapturedIntent is then used
 * to prefix the prompt.
 */
export async function runIntentGuard(
  taskId: string,
  userMessage: string,
  pushEventFn: (taskId: string, event: import("../types.js").StreamResponse) => void,
  abortSignal: AbortSignal
): Promise<CapturedIntent | null> {
  const analysis = analyzeAmbiguity(userMessage);
  if (!analysis) return null;

  const { id, promise } = createPendingIntentGuard({
    originalMessage: userMessage,
    question: analysis.question,
    narrowOption: analysis.narrowOption,
    broadOption: analysis.broadOption,
  });

  info("IntentGuard ambiguity detected:", {
    taskId,
    id,
    noun: analysis.entityNoun,
    question: analysis.question,
  });

  pushEventFn(taskId, {
    type: "intent_guard_request",
    data: {
      id,
      originalMessage: userMessage,
      question: analysis.question,
      narrowOption: analysis.narrowOption,
      broadOption: analysis.broadOption,
    } satisfies IntentGuardRequestPayload,
  });

  // Auto-resolve to "narrow" (safe default) if abort fires
  const onAbort = () => {
    autoResolveIntentGuard(id);
  };
  abortSignal.addEventListener("abort", onAbort, { once: true });

  let choice: "narrow" | "broad";
  try {
    choice = await promise;
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }

  const chosen = choice === "narrow" ? analysis.narrowOption : analysis.broadOption;

  info("IntentGuard resolved:", { taskId, id, choice, label: chosen.label });

  pushEventFn(taskId, {
    type: "intent_guard_resolved",
    data: { id, choice },
  });

  return {
    originalMessage: userMessage,
    clarifiedIntent: chosen.label,
    choice,
    promptPrefix: chosen.promptPrefix,
    operationType: choice === "narrow" ? "read" : "write",
    scope: choice === "narrow" ? "single" : "all",
    timestamp: Date.now(),
  };
}
