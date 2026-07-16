import { homedir } from "node:os";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type AuditSource = "tunnel" | "local";
export type AuditOutcome = "ok" | "error";

export interface AuditEntry {
  ts: string;
  id: string;
  tool: string;
  args_summary: Record<string, unknown>;
  outcome: AuditOutcome;
  code?: string;
  duration_ms: number;
  source: AuditSource;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_STRING_LEN = 200;

/** Keys that look like secrets — never logged (value replaced with [redacted]). */
const SECRET_KEY_PATTERN =
  /^(token|password|secret|api[_-]?key|auth|authorization|bearer|credential|private[_-]?key|access[_-]?token|refresh[_-]?token)$/i;

/** Content-heavy fields — omit full body, keep length hint only. */
const CONTENT_KEYS = new Set([
  "content",
  "new_string",
  "old_string",
  "data",
  "body",
  "file_content",
  "text",
]);

export function getAuditLogPath(logDir?: string): string {
  const dir = logDir ?? join(homedir(), ".deckagent", "logs");
  return join(dir, "audit.jsonl");
}

/**
 * Build a redacted args summary suitable for audit logs.
 * Truncates long strings, omits full file contents, redacts secrets.
 */
export function summarizeArgsForAudit(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith("_") || key.startsWith("__")) continue;
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (CONTENT_KEYS.has(key) && typeof value === "string") {
      out[key] =
        value.length > MAX_STRING_LEN
          ? `[omitted ${value.length} chars]`
          : value.length > 40
            ? `[omitted ${value.length} chars]`
            : value;
      continue;
    }
    out[key] = summarizeValue(value);
  }
  return out;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LEN) {
      return value.slice(0, MAX_STRING_LEN) + "…";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => summarizeValue(v));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nested: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (i++ >= 30) {
        nested["…"] = "truncated";
        break;
      }
      if (SECRET_KEY_PATTERN.test(k)) {
        nested[k] = "[redacted]";
      } else {
        nested[k] = summarizeValue(v);
      }
    }
    return nested;
  }
  return value;
}

export interface AuditLogOptions {
  /** Override log directory (tests). Default: ~/.deckagent/logs */
  logDir?: string;
  /** Rotate when file exceeds this size. Default: 50MB */
  maxBytes?: number;
}

/**
 * Append one JSON line to audit.jsonl. Rotates to audit.jsonl.1 when oversized.
 * Best-effort — never throws to callers.
 */
export function appendAuditLog(
  entry: AuditEntry,
  options?: AuditLogOptions,
): void {
  try {
    const logDir = options?.logDir ?? join(homedir(), ".deckagent", "logs");
    const path = join(logDir, "audit.jsonl");
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    rotateIfNeeded(path, maxBytes);

    const line = JSON.stringify(entry) + "\n";
    appendFileSync(path, line, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Never fail the tool flow because of audit logging.
  }
}

function rotateIfNeeded(path: string, maxBytes: number): void {
  if (!existsSync(path)) return;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  const rotated = `${path}.1`;
  try {
    // Simple single-backup rotation: overwrite previous .1 if present.
    renameSync(path, rotated);
  } catch {
    // If rotation fails, keep appending.
  }
}

/** Test helper — ensure parent dir exists without writing. */
export function ensureAuditLogDir(logDir: string): void {
  const dir = dirname(join(logDir, "audit.jsonl"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

/**
 * Read the last N lines from audit.jsonl (default 100, max 500).
 * Returns joined NDJSON text (no trailing newline if empty).
 */
export function readRecentAuditLog(options?: {
  limit?: number;
  logDir?: string;
}): string {
  let limit = options?.limit ?? DEFAULT_AUDIT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) {
    limit = DEFAULT_AUDIT_LIMIT;
  }
  limit = Math.min(Math.floor(limit), MAX_AUDIT_LIMIT);

  const path = getAuditLogPath(options?.logDir);
  if (!existsSync(path)) {
    return "";
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return "";
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const slice = lines.slice(-limit);
  return slice.join("\n");
}
