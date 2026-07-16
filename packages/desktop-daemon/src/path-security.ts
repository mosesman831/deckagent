/**
 * Path security engine (S3 + S5 + S9 + S10).
 * Evaluation order: sanitize → canonicalize → trusted? → denied? → protected?
 */
import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { Policy } from "./policy.js";
import {
  matchBuiltinProtection,
  matchUserProtectedPath,
  expandHomePattern,
} from "./builtin-protections.js";

export type PathOp = "read" | "write";

export interface PathAccessResult {
  allowed: boolean;
  code?: "PATH_UNTRUSTED" | "PATH_DENIED" | "PATH_PROTECTED";
  reason?: string;
  /** Final canonical path used for checks (when resolved). */
  canonical?: string;
}

/**
 * Expand ~ and produce an absolute normalized path (does not follow symlinks).
 */
export function expandAndResolve(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolvePath(join(homedir(), trimmed.slice(2)));
  }
  return resolvePath(trimmed);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeForCompare(inputPath: string): string {
  let normalized = normalize(inputPath);
  if (sep === "\\") {
    normalized = normalized.replace(/\//g, "\\");
  } else {
    normalized = normalized.replace(/\\/g, "/");
  }
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function pathsEqual(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function isPathInside(target: string, root: string): boolean {
  const t = normalizeForCompare(target);
  const r = normalizeForCompare(root);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function isUnsafeRawPath(inputPath: string): string | null {
  if (inputPath.includes("\0")) {
    return "Path contains NUL byte";
  }
  if (/\\\\\?\\/i.test(inputPath) || inputPath.includes("\\??\\")) {
    return "Windows device paths are not allowed";
  }
  return null;
}

/**
 * Effective trusted directories for an operation (S10 dual lists).
 */
export function getTrustedDirectories(policy: Policy, op: PathOp): string[] {
  if (op === "read" && policy.trusted_read_directories?.length) {
    return policy.trusted_read_directories;
  }
  if (op === "write" && policy.trusted_write_directories?.length) {
    return policy.trusted_write_directories;
  }
  if (policy.trusted_directories?.length) {
    return policy.trusted_directories;
  }
  // Migration: fall back to allowed_directories
  return policy.allowed_directories ?? [];
}

function expandTrustedList(dirs: string[]): string[] {
  return dirs.map((d) => normalizeForCompare(expandAndResolve(expandHomePattern(d))));
}

/**
 * Detect whether any path component is a symlink (for deny_symlinks mode).
 */
function pathHasSymlinkComponent(absolutePath: string): boolean {
  const resolved = expandAndResolve(absolutePath);
  const parts = resolved.split(sep).filter(Boolean);
  let current = resolved.startsWith(sep) ? sep : "";
  // Windows drive
  if (/^[a-zA-Z]:/.test(resolved)) {
    current = parts[0] + sep;
    parts.shift();
  }
  for (const part of parts) {
    current = current ? join(current, part) : join(sep, part);
    try {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Canonicalize per symlink_mode. Returns error result or canonical path.
 */
function canonicalizePath(
  inputPath: string,
  policy: Policy,
): { ok: true; canonical: string } | PathAccessResult {
  const mode = policy.path_rules?.symlink_mode ?? "deny_escape";
  const absolute = expandAndResolve(inputPath);

  if (mode === "deny_symlinks") {
    if (pathHasSymlinkComponent(absolute)) {
      return {
        allowed: false,
        code: "PATH_DENIED",
        reason: `[PATH_DENIED] Symlinks are not allowed (symlink_mode=deny_symlinks) for '${inputPath}'`,
      };
    }
    return { ok: true, canonical: absolute };
  }

  // deny_escape | follow — realpath final target; missing files: realpath parent + basename
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // File may not exist yet (writes). Resolve existing parent.
    try {
      const parent = dirname(absolute);
      const realParent = existsSync(parent) ? realpathSync(parent) : parent;
      canonical = join(realParent, absolute.slice(parent.length).replace(/^[\\/]/, "") || "");
      // join quirk: rebuild as join(realParent, basename)
      const base = absolute.split(/[/\\]/).pop() ?? "";
      canonical = join(realParent, base);
    } catch {
      canonical = absolute;
    }
  }

  return { ok: true, canonical };
}

function isTrusted(canonical: string, trustedDirs: string[]): boolean {
  const target = normalizeForCompare(canonical);
  for (const dir of trustedDirs) {
    if (pathsEqual(target, dir) || isPathInside(target, dir)) {
      return true;
    }
  }
  return false;
}

function isDenied(canonical: string, deniedDirs: string[]): string | null {
  const target = normalizeForCompare(canonical);
  for (const raw of deniedDirs) {
    const dir = normalizeForCompare(expandAndResolve(expandHomePattern(raw)));
    if (pathsEqual(target, dir) || isPathInside(target, dir)) {
      return raw;
    }
  }
  return null;
}

function isProtected(
  canonical: string,
  op: PathOp,
  policy: Policy,
): { protected: boolean; pattern?: string } {
  const pathPolicy = policy.protected_path_policy ?? "deny_write";

  // Builtin (unless disabled)
  if (!policy.disable_builtin_protections) {
    const builtin = matchBuiltinProtection(canonical, op);
    if (builtin.matched) {
      if (builtin.writeAlways && op === "write") {
        return { protected: true, pattern: builtin.pattern };
      }
      if (pathPolicy === "deny_all") {
        return { protected: true, pattern: builtin.pattern };
      }
      if (pathPolicy === "deny_write" && op === "write") {
        return { protected: true, pattern: builtin.pattern };
      }
    }
  }

  // User protected_paths
  for (const pattern of policy.protected_paths ?? []) {
    if (matchUserProtectedPath(canonical, pattern)) {
      if (pathPolicy === "deny_all") {
        return { protected: true, pattern };
      }
      if (pathPolicy === "deny_write" && op === "write") {
        return { protected: true, pattern };
      }
    }
  }

  return { protected: false };
}

/**
 * Evaluate whether a path may be accessed for the given operation.
 */
export function evaluatePathAccess(
  inputPath: string,
  op: PathOp,
  policy: Policy,
): PathAccessResult {
  if (!inputPath || typeof inputPath !== "string") {
    return {
      allowed: false,
      code: "PATH_DENIED",
      reason: "[PATH_DENIED] Empty path",
    };
  }

  const unsafe = isUnsafeRawPath(inputPath);
  if (unsafe) {
    return {
      allowed: false,
      code: "PATH_DENIED",
      reason: `[PATH_DENIED] ${unsafe}`,
    };
  }

  const allowDotdot = policy.path_rules?.allow_dotdot ?? false;
  if (!allowDotdot) {
    // Reject .. segments in the raw argument before resolve (belt and suspenders)
    const raw = inputPath.replace(/\\/g, "/");
    if (/(^|\/)\.\.(\/|$)/.test(raw)) {
      return {
        allowed: false,
        code: "PATH_DENIED",
        reason: `[PATH_DENIED] Path '${inputPath}' contains '..' (allow_dotdot=false)`,
      };
    }
  }

  const canonResult = canonicalizePath(inputPath, policy);
  if (!("ok" in canonResult) || !canonResult.ok) {
    return canonResult as PathAccessResult;
  }
  const canonical = canonResult.canonical;

  // For deny_escape / follow: final realpath must stay inside a trusted root.
  // (Already computed canonical via realpath when possible.)

  const trustedRaw = getTrustedDirectories(policy, op);
  const trustedDirs = expandTrustedList(trustedRaw);

  if (trustedDirs.length === 0) {
    return {
      allowed: false,
      code: "PATH_UNTRUSTED",
      reason: "[PATH_UNTRUSTED] No trusted directories configured",
      canonical,
    };
  }

  if (!isTrusted(canonical, trustedDirs)) {
    // Symlink escape: also check if the pre-realpath absolute was trusted but final is not
    return {
      allowed: false,
      code: "PATH_UNTRUSTED",
      reason: `[PATH_UNTRUSTED] Path '${inputPath}' resolves outside trusted directories`,
      canonical,
    };
  }

  const deniedHit = isDenied(canonical, policy.denied_directories ?? []);
  if (deniedHit) {
    return {
      allowed: false,
      code: "PATH_DENIED",
      reason: `[PATH_DENIED] Path '${inputPath}' is inside denied directory '${deniedHit}'`,
      canonical,
    };
  }

  const prot = isProtected(canonical, op, policy);
  if (prot.protected) {
    return {
      allowed: false,
      code: "PATH_PROTECTED",
      reason: `[PATH_PROTECTED] Refusing ${op} access to protected path '${inputPath}' (matched '${prot.pattern}')`,
      canonical,
    };
  }

  return { allowed: true, canonical };
}

/**
 * Check whether a sandbox binary is available for terminal_mode=sandbox_fs.
 */
export function findSandboxBinary(): string | null {
  const candidates =
    process.platform === "darwin"
      ? ["sandbox-exec", "bwrap"]
      : ["bwrap", "sandbox-exec"];
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(sep === "\\" ? ";" : ":");
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = join(dir, name);
      try {
        if (existsSync(full) && statSync(full).isFile()) {
          return full;
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

export { isPathInside, normalizeForCompare, pathsEqual, expandHomePattern };
