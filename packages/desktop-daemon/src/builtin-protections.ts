/**
 * Hardcoded sensitive-path protections (S9).
 * Always applied unless policy.disable_builtin_protections is true.
 *
 * Prefix patterns (no glob) match the path itself or anything underneath.
 * Glob patterns use ** / * semantics against the absolute path.
 *
 * ~/.deckagent/secrets.json and ~/.deckagent/config.json are write-deny-always
 * (even when protected_path_policy is deny_write and the op is otherwise allowed).
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Prefix/dir patterns — expand ~ at match time. */
export const BUILTIN_PROTECTED_PREFIXES: readonly string[] = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
];

/** Exact file paths that are always write-denied (regardless of deny_write vs deny_all). */
export const BUILTIN_WRITE_ALWAYS_DENY: readonly string[] = [
  "~/.deckagent/secrets.json",
  "~/.deckagent/config.json",
  "~/.docker/config.json",
];

/** Glob patterns matched against absolute paths (posix-normalized). */
export const BUILTIN_PROTECTED_GLOBS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/credentials.json",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
];

export interface BuiltinProtectionMatch {
  matched: boolean;
  pattern?: string;
  /** True when this is a write-always-deny entry (secrets/config). */
  writeAlways?: boolean;
}

/**
 * Expand a ~ path pattern to an absolute home-based path.
 */
export function expandHomePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Convert a simple glob (`**`, `*`) to a RegExp matched against a posix path.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      // ** — match across path segments
      if (glob[i + 2] === "/") {
        pattern += "(?:.*/)?";
        i += 3;
      } else {
        pattern += ".*";
        i += 2;
      }
      continue;
    }
    if (glob[i] === "*") {
      pattern += "[^/]*";
      i += 1;
      continue;
    }
    if (glob[i] === "?") {
      pattern += "[^/]";
      i += 1;
      continue;
    }
    const ch = glob[i]!;
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      pattern += "\\" + ch;
    } else {
      pattern += ch;
    }
    i += 1;
  }
  return new RegExp(`^${pattern}$`, "i");
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeComparePath(p: string): string {
  let s = toPosix(p);
  if (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}

function isUnderOrEqual(target: string, root: string): boolean {
  const t = normalizeComparePath(target);
  const r = normalizeComparePath(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith("/") ? r : r + "/");
}

/**
 * Check whether an absolute path matches a builtin protection rule.
 */
export function matchBuiltinProtection(
  absolutePath: string,
  op: "read" | "write",
): BuiltinProtectionMatch {
  const target = normalizeComparePath(absolutePath);

  for (const entry of BUILTIN_WRITE_ALWAYS_DENY) {
    const expanded = normalizeComparePath(expandHomePattern(entry));
    if (target === expanded || isUnderOrEqual(target, expanded)) {
      if (op === "write") {
        return { matched: true, pattern: entry, writeAlways: true };
      }
      // reads of secrets/config.json: still protected via deny_all; for deny_write
      // caller decides using protected_path_policy — treat as non-writeAlways match
      // so deny_write allows reads. Return no match for read here; prefix list does not include these.
    }
  }

  for (const prefix of BUILTIN_PROTECTED_PREFIXES) {
    const expanded = expandHomePattern(prefix);
    if (isUnderOrEqual(target, expanded)) {
      return { matched: true, pattern: prefix };
    }
  }

  // Also match write-always files as protected for deny_all reads
  for (const entry of BUILTIN_WRITE_ALWAYS_DENY) {
    const expanded = normalizeComparePath(expandHomePattern(entry));
    if (target === expanded) {
      return { matched: true, pattern: entry, writeAlways: op === "write" };
    }
  }

  const posixTarget = toPosix(target);
  for (const glob of BUILTIN_PROTECTED_GLOBS) {
    if (globToRegExp(glob).test(posixTarget)) {
      return { matched: true, pattern: glob };
    }
  }

  // Basename fallback for key material when path separators vary
  const base = posixTarget.split("/").pop() ?? "";
  if (
    base === "id_rsa" ||
    base === "id_ed25519" ||
    base === ".env" ||
    /^\.env\./i.test(base) ||
    /\.pem$/i.test(base) ||
    base === "credentials.json"
  ) {
    return { matched: true, pattern: `**/${base}` };
  }

  return { matched: false };
}

/**
 * Match a user-supplied protected_paths entry (prefix or glob) against an absolute path.
 */
export function matchUserProtectedPath(
  absolutePath: string,
  pattern: string,
): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  const target = normalizeComparePath(absolutePath);
  const posixTarget = toPosix(target);

  if (trimmed.includes("*") || trimmed.includes("?")) {
    // Expand leading ~/ in glob if present
    let glob = trimmed;
    if (glob.startsWith("~/")) {
      glob = toPosix(expandHomePattern(glob));
    }
    return globToRegExp(toPosix(glob)).test(posixTarget);
  }

  const expanded = expandHomePattern(trimmed);
  return isUnderOrEqual(target, expanded);
}
