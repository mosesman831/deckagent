import { z } from "zod";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath, isAbsolute, normalize, sep } from "node:path";

/**
 * Policy defaults (blocklist mode for backward compatibility):
 * - command_mode: "blocklist" | "allowlist" (default "blocklist")
 * - blocked_commands: used when command_mode is "blocklist"
 * - allowed_commands: used when command_mode is "allowlist"
 *   (substring or word-boundary match; empty list blocks all terminal commands)
 *
 * CLI `deckagent configure` may set command_mode/allowed_commands later;
 * daemon defaults stay blocklist for compatibility.
 */
export const PolicySchema = z.object({
  version: z.number().int().default(1),
  allowed_directories: z.array(z.string()).default(["~"]),
  blocked_commands: z.array(z.string()).default([
    "rm -rf",
    "sudo",
    "shutdown",
    "reboot",
    "poweroff",
    "init 0",
    "init 6",
    "dd",
    "mkfs",
    "curl|sh",
    "wget|sh",
  ]),
  /**
   * How terminal commands are filtered.
   * - blocklist (default): reject if matched by blocked_commands / dangerous patterns
   * - allowlist: only allow if matched by allowed_commands (empty = block all)
   */
  command_mode: z.enum(["blocklist", "allowlist"]).default("blocklist"),
  /** Substrings or single-token patterns; used when command_mode is "allowlist". */
  allowed_commands: z.array(z.string()).default([]),
  require_confirmation: z.array(z.string()).default([
    "execute_command",
    "write_file",
    "edit_file",
    "kill_process",
  ]),
  read_only: z.boolean().default(false),
  allow_browser: z.boolean().default(false),
  allow_terminal: z.boolean().default(true),
  allow_computer_use: z.boolean().default(false),
  max_file_read_size: z.number().int().positive().default(10 * 1024 * 1024),
  max_command_timeout: z.number().int().positive().default(300),
});

export type Policy = z.infer<typeof PolicySchema>;

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
  confirmationReason?: string;
}

const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "move_file",
  "kill_process",
  "execute_command",
  "execute_command_stream",
]);

const TERMINAL_TOOLS = new Set([
  "execute_command",
  "execute_command_stream",
  "list_processes",
  "kill_process",
]);

const BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_evaluate",
]);

/** Tools that omit path in schemas default to home (~). */
const PATH_DEFAULTS: Record<string, Record<string, string>> = {
  search_files: { path: "~" },
};

/**
 * Hardcoded dangerous patterns checked in addition to policy.blocked_commands.
 * Matching runs against a whitespace-collapsed, lowercased command string.
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\bdoas\b/,
  /\brkexec\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[\s\S]*\bif=/,
  /\bif=\/[^\s]*\b[\s\S]*\bdd\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  /\bhalt\b/,
  /:\s*\(\s*\)\s*\{/, // fork bomb :(){
  /\bfork\s*\(\s*\)\s*\{/, // crude fork bomb variants
  /\b(curl|wget)\b[\s\S]*\|\s*(?:ba|z|da)?sh\b/,
  /\b(curl|wget)\b[\s\S]*\|\s*python(?:3)?\b/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+\/(\s|$|[*])/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+\/\*/,
  /\bchmod\s+(-[a-zA-Z]*\s+)?777\s+\/(\s|$)/,
];

export function getPolicyPath(): string {
  return join(homedir(), ".deckagent", "policy.json");
}

export function createDefaultPolicy(): Policy {
  return PolicySchema.parse({});
}

export function readPolicy(path = getPolicyPath()): Policy {
  if (!existsSync(path)) {
    const defaultPolicy = createDefaultPolicy();
    writePolicy(defaultPolicy, path);
    return defaultPolicy;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read policy file: ${path} (${humanError(err)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Policy file contains invalid JSON: ${path}`);
  }

  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid policy: ${result.error.message}`);
  }

  return result.data;
}

export function writePolicy(policy: Policy, path = getPolicyPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const result = PolicySchema.safeParse(policy);
  if (!result.success) {
    throw new Error(`Cannot write invalid policy: ${result.error.message}`);
  }

  try {
    writeFileSync(path, JSON.stringify(result.data, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    throw new Error(`Failed to write policy file: ${path} (${humanError(err)})`);
  }
}

/** Collapse whitespace and lowercase for command matching. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if the command matches a blocked entry or a known dangerous pattern.
 * Keeps substring checks for policy list entries, and adds word-boundary matching
 * for single-token blocks plus common bypass patterns.
 */
export function isCommandBlocked(
  command: string,
  blockedList: string[],
): { blocked: boolean; matched?: string } {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return { blocked: false };
  }

  // Strip common obfuscation: zero-width / control chars already gone via normalize;
  // also collapse "$()" wrappers lightly by checking raw patterns on normalized form.
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, matched: pattern.source };
    }
  }

  for (const blocked of blockedList) {
    if (commandMatchesEntry(normalized, blocked)) {
      return { blocked: true, matched: blocked };
    }
  }

  return { blocked: false };
}

/**
 * Allowlist matching: command must match at least one allowed_commands entry
 * via normalized substring include or word-boundary (same helpers as blocklist).
 * Empty allowed list → not allowed (caller should block all terminal commands).
 */
export function isCommandAllowed(
  command: string,
  allowedList: string[],
): { allowed: boolean; matched?: string } {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return { allowed: false };
  }
  if (allowedList.length === 0) {
    return { allowed: false };
  }

  for (const allowed of allowedList) {
    if (commandMatchesEntry(normalized, allowed)) {
      return { allowed: true, matched: allowed };
    }
  }

  return { allowed: false };
}

/**
 * Shared entry matcher: pipe-style, substring include, or word-boundary for tokens.
 * `normalizedCommand` must already be normalizeCommand()'d.
 */
function commandMatchesEntry(normalizedCommand: string, rawEntry: string): boolean {
  const entry = normalizeCommand(rawEntry);
  if (!entry) return false;

  // Pipe-style entries like "curl|sh" → match curl ... | sh
  if (entry.includes("|") && !entry.includes(" ")) {
    const parts = entry.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const left = escapeRegex(parts[0]!);
      const right = escapeRegex(parts[parts.length - 1]!);
      const pipePattern = new RegExp(
        `\\b${left}\\b[\\s\\S]*\\|\\s*(?:ba|z|da)?${right}\\b`,
      );
      if (pipePattern.test(normalizedCommand)) {
        return true;
      }
    }
  }

  // Substring check (legacy / explicit multi-word)
  if (normalizedCommand.includes(entry)) {
    return true;
  }

  // Word-boundary for single-token entries
  if (!/\s/.test(entry) && !entry.includes("|")) {
    const wordPattern = new RegExp(
      `(?:^|[^a-z0-9_])${escapeRegex(entry)}(?:[^a-z0-9_]|$)`,
    );
    if (wordPattern.test(normalizedCommand)) {
      return true;
    }
  }

  return false;
}

/**
 * Apply known schema defaults for omitted path arguments before policy checks.
 * Mutates a shallow copy — does not mutate the caller's object.
 */
export function applyPathDefaults(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = PATH_DEFAULTS[toolName];
  if (!defaults) return { ...args };

  const next = { ...args };
  for (const [key, value] of Object.entries(defaults)) {
    if (next[key] === undefined || next[key] === null || next[key] === "") {
      next[key] = value;
    }
  }
  return next;
}

export function checkToolAllowed(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy,
): PolicyResult {
  const allTools = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
    "list_directory",
    "create_directory",
    "move_file",
    "get_file_info",
    "read_multiple_files",
    "execute_command",
    "execute_command_stream",
    "list_processes",
    "kill_process",
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_evaluate",
    "get_environment",
  ]);

  if (!allTools.has(toolName)) {
    return { allowed: false, reason: `Unknown tool: ${toolName}` };
  }

  if (policy.read_only && MUTATING_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is blocked because policy is read-only`,
    };
  }

  if (!policy.allow_terminal && TERMINAL_TOOLS.has(toolName)) {
    return { allowed: false, reason: `Terminal tools are disabled by policy` };
  }

  if (!policy.allow_browser && BROWSER_TOOLS.has(toolName)) {
    return { allowed: false, reason: `Browser tools are disabled by policy` };
  }

  const argsWithDefaults = applyPathDefaults(toolName, args);

  const command = typeof argsWithDefaults.command === "string" ? argsWithDefaults.command : "";
  if (command && TERMINAL_TOOLS.has(toolName)) {
    const commandCheck = checkCommandPolicy(command, policy);
    if (!commandCheck.allowed) {
      return commandCheck;
    }
  }

  const pathResult = checkPathAllowed(toolName, argsWithDefaults, policy);
  if (!pathResult.allowed) {
    return pathResult;
  }

  if (policy.require_confirmation.includes(toolName)) {
    const reason = command
      ? `Tool '${toolName}' with command '${command}' requires confirmation`
      : `Tool '${toolName}' requires confirmation`;
    return {
      allowed: true,
      requiresConfirmation: true,
      confirmationReason: reason,
    };
  }

  return { allowed: true };
}

/**
 * Apply command_mode (blocklist vs allowlist) to a terminal command string.
 */
export function checkCommandPolicy(
  command: string,
  policy: Policy,
): PolicyResult {
  if (policy.command_mode === "allowlist") {
    if (policy.allowed_commands.length === 0) {
      return {
        allowed: false,
        reason:
          "Command blocked by policy: command_mode is allowlist but allowed_commands is empty (all terminal commands blocked)",
      };
    }
    // Still reject known-dangerous patterns even in allowlist mode.
    const dangerous = isCommandBlocked(command, []);
    if (dangerous.blocked) {
      return {
        allowed: false,
        reason: `Command blocked by policy: matched dangerous pattern '${dangerous.matched ?? "dangerous pattern"}'`,
      };
    }
    const allowResult = isCommandAllowed(command, policy.allowed_commands);
    if (!allowResult.allowed) {
      return {
        allowed: false,
        reason:
          "Command blocked by policy: command_mode is allowlist and command does not match any allowed_commands entry",
      };
    }
    return { allowed: true };
  }

  // blocklist (default)
  const blockResult = isCommandBlocked(command, policy.blocked_commands);
  if (blockResult.blocked) {
    return {
      allowed: false,
      reason: `Command blocked by policy: matched '${blockResult.matched ?? "dangerous pattern"}'`,
    };
  }
  return { allowed: true };
}

function checkPathAllowed(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy,
): PolicyResult {
  void toolName;
  const pathKeys = ["path", "source", "destination", "workdir"];

  for (const key of pathKeys) {
    const value = args[key];
    if (typeof value !== "string" || !value) continue;

    if (!isPathAllowed(value, policy)) {
      return {
        allowed: false,
        reason: `Path '${value}' is outside allowed directories`,
      };
    }
  }

  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p !== "string") continue;
      if (!isPathAllowed(p, policy)) {
        return {
          allowed: false,
          reason: `Path '${p}' is outside allowed directories`,
        };
      }
    }
  }

  return { allowed: true };
}

export function isPathAllowed(inputPath: string, policy: Policy): boolean {
  const resolved = resolvePathWithHome(inputPath);
  let realPath: string;

  try {
    realPath = realpathSync(resolved);
  } catch {
    realPath = resolved;
  }

  const normalizedTarget = normalizePathForCompare(realPath);
  if (!isAbsolute(normalizedTarget) && !isAbsolute(realPath)) {
    return false;
  }

  const allowedDirs = policy.allowed_directories.map((d) =>
    normalizePathForCompare(resolvePathWithHome(d)),
  );

  for (const allowed of allowedDirs) {
    if (pathsEqual(normalizedTarget, allowed)) {
      return true;
    }
    if (isPathInside(normalizedTarget, allowed)) {
      return true;
    }
  }

  return false;
}

function resolvePathWithHome(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolvePath(trimmed);
}

/** Normalize separators and casing for cross-platform prefix checks. */
function normalizePathForCompare(inputPath: string): string {
  let normalized = normalize(inputPath);
  // Unify separators to platform sep after normalize (handles mixed / and \)
  if (sep === "\\") {
    normalized = normalized.replace(/\//g, "\\");
  } else {
    normalized = normalized.replace(/\\/g, "/");
  }
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  // Strip trailing separator (except root)
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function pathsEqual(a: string, b: string): boolean {
  return a === b;
}

function isPathInside(target: string, allowedDir: string): boolean {
  const prefix = allowedDir.endsWith(sep) ? allowedDir : allowedDir + sep;
  return target.startsWith(prefix);
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
