import { appendToolResult } from "../adapters/tools.js";

/** Max automatic continue fetches after a user turn before requiring a manual send. */
export const MAX_AUTO_CONTINUES = 3;

/** Debounce window to coalesce rapid tool_result batches before resubmitting. */
export const AUTO_CONTINUE_DEBOUNCE_MS = 250;

export type ToolResultItem = {
  name: string;
  args?: Record<string, unknown>;
  ok: boolean;
  content?: string;
  error?: string;
};

export type AutoContinueState = {
  /** Number of auto-continues performed in the current user turn. */
  count: number;
  /** Timestamp of the last auto-continue attempt (ms). */
  lastAt: number;
};

export type CachedChatRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  adapterType: string;
  requestId: string;
};

export type AutoContinueDecision =
  | { action: "resubmit"; body: string; contents: string[] }
  | { action: "queue"; reason: string }
  | { action: "stop"; reason: string };

export function createAutoContinueState(): AutoContinueState {
  return { count: 0, lastAt: 0 };
}

/** Reset when the user initiates a new chat request (not an auto-continue). */
export function resetAutoContinue(state: AutoContinueState): void {
  state.count = 0;
  state.lastAt = 0;
}

export function canAutoContinue(state: AutoContinueState): boolean {
  return state.count < MAX_AUTO_CONTINUES;
}

export function recordAutoContinue(state: AutoContinueState, now = Date.now()): void {
  state.count += 1;
  state.lastAt = now;
}

export function remainingAutoContinues(state: AutoContinueState): number {
  return Math.max(0, MAX_AUTO_CONTINUES - state.count);
}

/** True if `body` is JSON with a top-level `messages` array. */
export function hasMessagesArray(body: string): boolean {
  if (!body || !body.trim()) return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as Record<string, unknown>).messages)
    );
  } catch {
    return false;
  }
}

export function anyToolError(results: readonly ToolResultItem[]): boolean {
  return results.some((r) => !r.ok);
}

/** Format each tool result into a string suitable for appendToolResult. */
export function formatResultContents(results: readonly ToolResultItem[]): string[] {
  return results.map((item) => {
    const content = item.ok
      ? (item.content ?? "")
      : `Error executing ${item.name}: ${item.error ?? "unknown"}`;
    return `${item.name}: ${content}`;
  });
}

/**
 * Append one or more tool result strings onto an adapter request body.
 * Returns null when the body has no messages array or append is a no-op.
 */
export function appendResultsToBody(
  adapterType: string,
  body: string,
  contents: readonly string[]
): string | null {
  if (!hasMessagesArray(body)) return null;
  if (contents.length === 0) return null;

  const appendFn = appendToolResult[adapterType] ?? appendToolResult.deepseek;
  if (!appendFn) return null;

  let next = body;
  for (const content of contents) {
    next = appendFn(next, content);
  }

  if (next === body) return null;
  if (!hasMessagesArray(next)) return null;
  return next;
}

/**
 * Decide whether to auto-resubmit, queue for the next user send, or stop.
 * Pure decision helper — callers perform fetch / overlay / debounce side effects.
 */
export function decideAutoContinue(opts: {
  state: AutoContinueState;
  results: readonly ToolResultItem[];
  adapterType: string;
  requestBody: string | null | undefined;
}): AutoContinueDecision {
  if (opts.results.length === 0) {
    return { action: "stop", reason: "No tool results to continue with" };
  }

  if (anyToolError(opts.results)) {
    return { action: "stop", reason: "Tool execution failed" };
  }

  if (!canAutoContinue(opts.state)) {
    return {
      action: "queue",
      reason: `Auto-continue limit reached (${MAX_AUTO_CONTINUES} per turn)`
    };
  }

  if (!opts.requestBody) {
    return { action: "queue", reason: "No cached request body for resubmit" };
  }

  if (!hasMessagesArray(opts.requestBody)) {
    return { action: "queue", reason: "Request body has no messages array" };
  }

  const contents = formatResultContents(opts.results);
  const body = appendResultsToBody(opts.adapterType, opts.requestBody, contents);
  if (!body) {
    return { action: "queue", reason: "Failed to append tool results to request body" };
  }

  return { action: "resubmit", body, contents };
}
