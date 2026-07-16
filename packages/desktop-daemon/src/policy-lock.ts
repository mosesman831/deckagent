import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Header the Control UI must send to step-up when profile_locked. */
export const UNLOCK_HEADER = "x-deckagent-unlock";

/** Unlock tokens expire after 5 minutes. */
export const UNLOCK_TTL_MS = 5 * 60 * 1000;

export interface UnlockTokenRecord {
  token: string;
  created_at: string;
  expires_at: string;
}

export function getDeckAgentDir(baseDir?: string): string {
  return baseDir ?? join(homedir(), ".deckagent");
}

export function getUnlockTokenPath(baseDir?: string): string {
  return join(getDeckAgentDir(baseDir), "unlock.token");
}

function writeSecureFile(filePath: string, contents: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, contents, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on some Windows setups; mode on create is best-effort.
  }
}

/**
 * Create a one-time unlock token for Control UI step-up.
 * Writes ~/.deckagent/unlock.token (0600, TTL 5 min). Returns the token once.
 */
export function createUnlockToken(baseDir?: string): UnlockTokenRecord {
  const now = Date.now();
  const record: UnlockTokenRecord = {
    token: randomBytes(32).toString("hex"),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + UNLOCK_TTL_MS).toISOString(),
  };
  writeSecureFile(
    getUnlockTokenPath(baseDir),
    JSON.stringify(record, null, 2) + "\n",
  );
  return record;
}

export function readUnlockTokenRecord(
  baseDir?: string,
): UnlockTokenRecord | null {
  const filePath = getUnlockTokenPath(baseDir);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      typeof (raw as UnlockTokenRecord).token !== "string" ||
      typeof (raw as UnlockTokenRecord).expires_at !== "string"
    ) {
      return null;
    }
    return raw as UnlockTokenRecord;
  } catch {
    return null;
  }
}

export function clearUnlockToken(baseDir?: string): void {
  const filePath = getUnlockTokenPath(baseDir);
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore missing file.
  }
}

export function isUnlockTokenExpired(
  record: UnlockTokenRecord,
  nowMs: number = Date.now(),
): boolean {
  const expires = Date.parse(record.expires_at);
  if (!Number.isFinite(expires)) return true;
  return nowMs >= expires;
}

/**
 * Validate a presented unlock token against the on-disk record.
 * Does not consume the token.
 */
export function isValidUnlockToken(
  presented: string | undefined | null,
  baseDir?: string,
  nowMs: number = Date.now(),
): boolean {
  if (!presented || typeof presented !== "string" || !presented.trim()) {
    return false;
  }
  const record = readUnlockTokenRecord(baseDir);
  if (!record) return false;
  if (isUnlockTokenExpired(record, nowMs)) {
    clearUnlockToken(baseDir);
    return false;
  }
  return presented.trim() === record.token;
}

/**
 * Validate and consume (delete) a one-time unlock token.
 * Returns true if the token was valid and not expired.
 */
export function validateAndConsumeUnlockToken(
  presented: string | undefined | null,
  baseDir?: string,
  nowMs: number = Date.now(),
): boolean {
  if (!isValidUnlockToken(presented, baseDir, nowMs)) {
    return false;
  }
  clearUnlockToken(baseDir);
  return true;
}

/**
 * Extract unlock token from request header and/or JSON body.
 * Header wins when both are present.
 */
export function extractUnlockToken(options: {
  headerValue?: string | string[] | undefined;
  body?: Record<string, unknown> | null;
}): string | undefined {
  const rawHeader = options.headerValue;
  if (typeof rawHeader === "string" && rawHeader.trim()) {
    return rawHeader.trim();
  }
  if (Array.isArray(rawHeader)) {
    const first = rawHeader.find((v) => typeof v === "string" && v.trim());
    if (first) return first.trim();
  }
  const bodyToken = options.body?.token;
  if (typeof bodyToken === "string" && bodyToken.trim()) {
    return bodyToken.trim();
  }
  return undefined;
}
