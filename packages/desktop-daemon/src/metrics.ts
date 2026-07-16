import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const MetricsSchema = z
  .object({
    tool_ok: z.number().int().nonnegative().default(0),
    tool_denied_by_code: z.record(z.number().int().nonnegative()).default({}),
    confirmations: z.number().int().nonnegative().default(0),
    reconnects: z.number().int().nonnegative().default(0),
    last_updated: z.string().min(1),
  })
  .strict();

export type DaemonMetrics = z.infer<typeof MetricsSchema>;

let metricsPathForTest: string | null = null;

export function getMetricsPath(): string {
  return metricsPathForTest ?? join(homedir(), ".deckagent", "metrics.json");
}

export function readMetricsSnapshot(path = getMetricsPath()): DaemonMetrics {
  if (!existsSync(path)) {
    return createEmptyMetrics();
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const parsed = MetricsSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Fall through to a fresh snapshot. Metrics are observability, not control.
  }

  return createEmptyMetrics();
}

export function recordToolOk(): void {
  updateMetrics((metrics) => {
    metrics.tool_ok += 1;
  });
}

export function recordToolDeniedByCode(code: string): void {
  const safeCode = code.trim() || "UNKNOWN";
  updateMetrics((metrics) => {
    metrics.tool_denied_by_code[safeCode] =
      (metrics.tool_denied_by_code[safeCode] ?? 0) + 1;
  });
}

export function recordConfirmationMetric(): void {
  updateMetrics((metrics) => {
    metrics.confirmations += 1;
  });
}

export function recordReconnectMetric(): void {
  updateMetrics((metrics) => {
    metrics.reconnects += 1;
  });
}

export function setMetricsPathForTest(path: string | null): void {
  metricsPathForTest = path;
}

export function resetMetricsForTest(): void {
  writeMetricsSnapshot(createEmptyMetrics());
}

function updateMetrics(mutator: (metrics: DaemonMetrics) => void): void {
  try {
    const metrics = readMetricsSnapshot();
    mutator(metrics);
    metrics.last_updated = new Date().toISOString();
    writeMetricsSnapshot(metrics);
  } catch {
    // Metrics must never break tool execution or reconnect behavior.
  }
}

function writeMetricsSnapshot(metrics: DaemonMetrics): void {
  const path = getMetricsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(MetricsSchema.parse(metrics), null, 2) + "\n", {
    mode: 0o600,
  });
  chmodBestEffort(path);
}

function createEmptyMetrics(): DaemonMetrics {
  return {
    tool_ok: 0,
    tool_denied_by_code: {},
    confirmations: 0,
    reconnects: 0,
    last_updated: new Date().toISOString(),
  };
}

function chmodBestEffort(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some platforms/filesystems do not support POSIX modes.
  }
}
