import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Policy } from "./policy.js";
import { appendErrorHint } from "./error-hints.js";

const WINDOW_MS = 60 * 60 * 1000;

const TimestampedAmountSchema = z.object({
  ts: z.number(),
  amount: z.number().nonnegative(),
});

const BudgetStateSchema = z.object({
  version: z.number().int().default(1),
  tool_calls: z.array(z.number()).default([]),
  shell_seconds: z.array(TimestampedAmountSchema).default([]),
  bytes_written: z.array(TimestampedAmountSchema).default([]),
  confirmations: z.array(z.number()).default([]),
});

type BudgetState = z.infer<typeof BudgetStateSchema>;

let budgetsPathOverride: string | null = null;

export function getBudgetsPath(): string {
  if (budgetsPathOverride) return budgetsPathOverride;
  return join(homedir(), ".deckagent", "budgets.json");
}

/** Test helper — point budget state at a temp file. Pass null to reset. */
export function setBudgetsPathForTest(path: string | null): void {
  budgetsPathOverride = path;
}

export interface BudgetCheckResult {
  ok: boolean;
  code?: "BUDGET_EXCEEDED";
  message?: string;
  budget?:
    | "max_tool_calls_per_hour"
    | "max_shell_seconds_per_hour"
    | "max_bytes_written_per_hour"
    | "max_confirmations_per_hour";
  /** When the oldest event in the blocking bucket ages out (ISO). */
  resets_at?: string;
}

export interface BudgetStatus {
  max_tool_calls_per_hour: number;
  max_shell_seconds_per_hour: number;
  max_bytes_written_per_hour: number;
  max_confirmations_per_hour: number;
  tool_calls_used: number;
  shell_seconds_used: number;
  bytes_written_used: number;
  confirmations_used: number;
  tool_calls_remaining: number;
  shell_seconds_remaining: number;
  bytes_written_remaining: number;
  confirmations_remaining: number;
}

function emptyState(): BudgetState {
  return {
    version: 1,
    tool_calls: [],
    shell_seconds: [],
    bytes_written: [],
    confirmations: [],
  };
}

function readState(path = getBudgetsPath()): BudgetState {
  if (!existsSync(path)) {
    return emptyState();
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = BudgetStateSchema.safeParse(parsed);
    if (!result.success) return emptyState();
    return pruneState(result.data, Date.now());
  } catch {
    return emptyState();
  }
}

function writeState(state: BudgetState, path = getBudgetsPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best-effort persistence — never fail tool flow.
  }
}

function pruneState(state: BudgetState, now: number): BudgetState {
  const cutoff = now - WINDOW_MS;
  return {
    version: state.version,
    tool_calls: state.tool_calls.filter((ts) => ts > cutoff),
    shell_seconds: state.shell_seconds.filter((e) => e.ts > cutoff),
    bytes_written: state.bytes_written.filter((e) => e.ts > cutoff),
    confirmations: state.confirmations.filter((ts) => ts > cutoff),
  };
}

function sumAmounts(entries: Array<{ amount: number }>): number {
  let total = 0;
  for (const e of entries) total += e.amount;
  return total;
}

function oldestResetIso(timestamps: number[], now: number): string {
  if (timestamps.length === 0) {
    return new Date(now + WINDOW_MS).toISOString();
  }
  const oldest = Math.min(...timestamps);
  return new Date(oldest + WINDOW_MS).toISOString();
}

/**
 * Check whether the next tool call (and optional confirmation) would exceed budgets.
 */
export function checkBudget(
  policy: Policy,
  options?: { forConfirmation?: boolean },
): BudgetCheckResult {
  const budgets = policy.budgets;
  const now = Date.now();
  const state = pruneState(readState(), now);

  if (state.tool_calls.length >= budgets.max_tool_calls_per_hour) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      budget: "max_tool_calls_per_hour",
      message: appendErrorHint(
        `Budget exceeded: max_tool_calls_per_hour (${budgets.max_tool_calls_per_hour}) reached. Try again after ${oldestResetIso(state.tool_calls, now)}.`,
        "BUDGET_EXCEEDED",
      ),
      resets_at: oldestResetIso(state.tool_calls, now),
    };
  }

  const shellUsed = sumAmounts(state.shell_seconds);
  if (shellUsed >= budgets.max_shell_seconds_per_hour) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      budget: "max_shell_seconds_per_hour",
      message: appendErrorHint(
        `Budget exceeded: max_shell_seconds_per_hour (${budgets.max_shell_seconds_per_hour}) reached. Try again after ${oldestResetIso(
          state.shell_seconds.map((e) => e.ts),
          now,
        )}.`,
        "BUDGET_EXCEEDED",
      ),
      resets_at: oldestResetIso(
        state.shell_seconds.map((e) => e.ts),
        now,
      ),
    };
  }

  const bytesUsed = sumAmounts(state.bytes_written);
  if (bytesUsed >= budgets.max_bytes_written_per_hour) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      budget: "max_bytes_written_per_hour",
      message: appendErrorHint(
        `Budget exceeded: max_bytes_written_per_hour (${budgets.max_bytes_written_per_hour}) reached. Try again after ${oldestResetIso(
          state.bytes_written.map((e) => e.ts),
          now,
        )}.`,
        "BUDGET_EXCEEDED",
      ),
      resets_at: oldestResetIso(
        state.bytes_written.map((e) => e.ts),
        now,
      ),
    };
  }

  if (
    options?.forConfirmation &&
    state.confirmations.length >= budgets.max_confirmations_per_hour
  ) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      budget: "max_confirmations_per_hour",
      message: appendErrorHint(
        `Budget exceeded: max_confirmations_per_hour (${budgets.max_confirmations_per_hour}) reached. Try again after ${oldestResetIso(state.confirmations, now)}.`,
        "BUDGET_EXCEEDED",
      ),
      resets_at: oldestResetIso(state.confirmations, now),
    };
  }

  return { ok: true };
}

export function recordToolCall(): void {
  const now = Date.now();
  const state = pruneState(readState(), now);
  state.tool_calls.push(now);
  writeState(state);
}

export function recordShellSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const now = Date.now();
  const state = pruneState(readState(), now);
  state.shell_seconds.push({ ts: now, amount: seconds });
  writeState(state);
}

export function recordBytesWritten(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const now = Date.now();
  const state = pruneState(readState(), now);
  state.bytes_written.push({ ts: now, amount: Math.floor(bytes) });
  writeState(state);
}

export function recordConfirmation(): void {
  const now = Date.now();
  const state = pruneState(readState(), now);
  state.confirmations.push(now);
  writeState(state);
}

export function getBudgetStatus(policy: Policy): BudgetStatus {
  const budgets = policy.budgets;
  const now = Date.now();
  const state = pruneState(readState(), now);

  const tool_calls_used = state.tool_calls.length;
  const shell_seconds_used = sumAmounts(state.shell_seconds);
  const bytes_written_used = sumAmounts(state.bytes_written);
  const confirmations_used = state.confirmations.length;

  return {
    max_tool_calls_per_hour: budgets.max_tool_calls_per_hour,
    max_shell_seconds_per_hour: budgets.max_shell_seconds_per_hour,
    max_bytes_written_per_hour: budgets.max_bytes_written_per_hour,
    max_confirmations_per_hour: budgets.max_confirmations_per_hour,
    tool_calls_used,
    shell_seconds_used,
    bytes_written_used,
    confirmations_used,
    tool_calls_remaining: Math.max(
      0,
      budgets.max_tool_calls_per_hour - tool_calls_used,
    ),
    shell_seconds_remaining: Math.max(
      0,
      budgets.max_shell_seconds_per_hour - shell_seconds_used,
    ),
    bytes_written_remaining: Math.max(
      0,
      budgets.max_bytes_written_per_hour - bytes_written_used,
    ),
    confirmations_remaining: Math.max(
      0,
      budgets.max_confirmations_per_hour - confirmations_used,
    ),
  };
}

/** Reset in-memory/persisted counters (tests). */
export function resetBudgetsForTest(): void {
  writeState(emptyState());
}
