import type { StreamResponse } from "../types.js";
import { info, warn } from "./logger.js";

export type TaskStatus = "running" | "done" | "error" | "aborted";

export interface BufferedEvent {
  seq: number;
  event: StreamResponse;
}

export type TaskSubscriber = (event: BufferedEvent) => void;

export interface Task {
  taskId: string;
  /** Latest session_id seen from the SDK stream — surfaced to clients so
   *  they can resume the Claude conversation across new prompts. */
  sessionId: string | null;
  /** The cwd the SDK was spawned with. Used to scope active-task listings
   *  per workspace so we don't leak tasks across project switches. */
  workingDirectory: string | null;
  status: TaskStatus;
  /** Append-only event log. `seq` matches array index — never reorder. */
  events: BufferedEvent[];
  nextSeq: number;
  subscribers: Set<TaskSubscriber>;
  createdAt: number;
  /** Bumped on every event push and every (un)subscribe so the idle-TTL
   *  cleanup tick can tell if a finished task is still being read. */
  lastActivityAt: number;
  abortController: AbortController;
  /** Rough byte estimate of `events` for soft-cap eviction. */
  byteEstimate: number;
  /** Set to true once a permission prompt times out without a user
   *  response (default: 5 min). Every SUBSEQUENT canUseTool in this task
   *  auto-allows without waiting — the user is presumed absent and we
   *  don't want the task to stall on every tool call. Resets to false
   *  only when a brand-new task starts (per-task scope). */
  absentMode: boolean;
}

const tasks = new Map<string, Task>();

/** Idle TTL for completed/errored/aborted tasks. While a task is `running`
 *  it's never evicted regardless of how long it sits — the SDK call itself
 *  is the work that needs to complete. */
const COMPLETED_TASK_TTL_MS = 30 * 60 * 1000; // 30 min
/** Per-task buffer soft cap. When exceeded, we drop the oldest event from
 *  the buffer to make room — but we never drop `permission_request` events
 *  (those are referenced by an external pending Promise the user still
 *  needs to answer) and we never drop the most recent 50 events. */
const MAX_BYTES_PER_TASK = 10 * 1024 * 1024; // 10MB
const PROTECTED_TAIL = 50;

/* ============================================================
   Lifecycle
   ============================================================ */

export function createTask(opts: {
  taskId: string;
  workingDirectory: string | null;
  abortController: AbortController;
}): Task {
  const task: Task = {
    taskId: opts.taskId,
    sessionId: null,
    workingDirectory: opts.workingDirectory,
    status: "running",
    events: [],
    nextSeq: 0,
    subscribers: new Set(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    abortController: opts.abortController,
    byteEstimate: 0,
    absentMode: false,
  };
  tasks.set(opts.taskId, task);
  info("Task created:", {
    taskId: opts.taskId,
    workingDirectory: opts.workingDirectory,
  });
  return task;
}

/** Mark the task as "user absent" — every subsequent canUseTool in this
 *  task will auto-allow without waiting. */
export function setTaskAbsentMode(taskId: string, value: boolean): void {
  const task = tasks.get(taskId);
  if (!task) return;
  if (task.absentMode === value) return;
  task.absentMode = value;
  info("Task absent-mode:", { taskId, value });
}

export function getTask(taskId: string): Task | undefined {
  return tasks.get(taskId);
}

export function setTaskStatus(taskId: string, status: TaskStatus): void {
  const task = tasks.get(taskId);
  if (!task) return;
  task.status = status;
  task.lastActivityAt = Date.now();
  info("Task status:", { taskId, status });
}

export function setTaskSessionId(taskId: string, sessionId: string): void {
  const task = tasks.get(taskId);
  if (!task) return;
  if (task.sessionId !== sessionId) {
    task.sessionId = sessionId;
  }
}

/* ============================================================
   Event push + delivery
   ============================================================ */

function estimateBytes(event: StreamResponse): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 256;
  }
}

function evictIfNeeded(task: Task): void {
  if (task.byteEstimate <= MAX_BYTES_PER_TASK) return;
  // Walk from oldest to youngest, dropping evictable events until we're
  // back under the cap. Never touch the tail (protected) or permission
  // requests (still referenced by a pending Promise).
  const tailStart = Math.max(0, task.events.length - PROTECTED_TAIL);
  let i = 0;
  while (task.byteEstimate > MAX_BYTES_PER_TASK && i < tailStart) {
    const bev = task.events[i];
    if (!bev) {
      i++;
      continue;
    }
    if (bev.event.type === "permission_request") {
      i++;
      continue;
    }
    const sz = estimateBytes(bev.event);
    // Replace with a sentinel so seq numbering stays intact. Subscribers
    // and replay logic see a tiny placeholder instead of the heavy event.
    task.events[i] = {
      seq: bev.seq,
      event: { type: "heartbeat" },
    };
    task.byteEstimate -= Math.max(0, sz - 32);
    i++;
  }
  if (task.byteEstimate > MAX_BYTES_PER_TASK) {
    warn("Task buffer still over cap after eviction:", {
      taskId: task.taskId,
      byteEstimate: task.byteEstimate,
    });
  }
}

export function pushEvent(taskId: string, event: StreamResponse): void {
  const task = tasks.get(taskId);
  if (!task) return;
  const buffered: BufferedEvent = { seq: task.nextSeq++, event };
  task.events.push(buffered);
  task.byteEstimate += estimateBytes(event);
  task.lastActivityAt = Date.now();
  evictIfNeeded(task);
  // Snapshot subscribers so a synchronous unsubscribe inside cb doesn't
  // skip later subscribers.
  for (const cb of [...task.subscribers]) {
    try {
      cb(buffered);
    } catch (err) {
      warn("Task subscriber threw:", {
        taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/* ============================================================
   Subscription (replay + live tail)
   ============================================================ */

/** Replay every buffered event with seq >= fromSeq, then live-tail. The
 *  caller's `cb` is invoked synchronously for the replay portion and
 *  asynchronously thereafter. Returns an unsubscribe function. */
export function subscribeToTask(
  taskId: string,
  fromSeq: number,
  cb: TaskSubscriber
): (() => void) | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  // Replay buffered events first.
  for (const bev of task.events) {
    if (bev.seq < fromSeq) continue;
    try {
      cb(bev);
    } catch (err) {
      warn("Replay cb threw:", {
        taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // If task is already finished AND all events delivered, no live tail
  // needed — caller is done after the replay.
  if (task.status !== "running") {
    task.lastActivityAt = Date.now();
    return () => {
      task.lastActivityAt = Date.now();
    };
  }
  task.subscribers.add(cb);
  task.lastActivityAt = Date.now();
  return () => {
    task.subscribers.delete(cb);
    task.lastActivityAt = Date.now();
  };
}

/* ============================================================
   Listing + abort
   ============================================================ */

export interface TaskSummary {
  taskId: string;
  sessionId: string | null;
  workingDirectory: string | null;
  status: TaskStatus;
  createdAt: number;
  lastActivityAt: number;
  lastSeq: number;
}

export function listActiveTasks(workingDirectory?: string | null): TaskSummary[] {
  const out: TaskSummary[] = [];
  for (const task of tasks.values()) {
    if (workingDirectory && task.workingDirectory !== workingDirectory) continue;
    out.push({
      taskId: task.taskId,
      sessionId: task.sessionId,
      workingDirectory: task.workingDirectory,
      status: task.status,
      createdAt: task.createdAt,
      lastActivityAt: task.lastActivityAt,
      lastSeq: task.nextSeq - 1,
    });
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export function abortTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (task.status !== "running") return false;
  task.abortController.abort();
  setTaskStatus(taskId, "aborted");
  pushEvent(taskId, { type: "aborted" });
  return true;
}

/* ============================================================
   Idle cleanup tick
   ============================================================ */

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [taskId, task] of tasks) {
    if (task.status === "running") continue;
    if (task.subscribers.size > 0) continue;
    if (now - task.lastActivityAt < COMPLETED_TASK_TTL_MS) continue;
    tasks.delete(taskId);
    info("Task evicted (idle TTL):", {
      taskId,
      status: task.status,
      ageMs: now - task.lastActivityAt,
    });
  }
}, 60_000);
// Don't keep the Node process alive just for this tick.
cleanupTimer.unref?.();
