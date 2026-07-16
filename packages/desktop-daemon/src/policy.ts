import { z } from "zod";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath, isAbsolute, normalize, sep } from "node:path";
import { normalizePolicy as applyNormalizePolicy, describeNormalizationFixes } from "./security-profiles.js";
import {
  evaluatePathAccess,
  expandAndResolve,
  findSandboxBinary,
  getTrustedDirectories,
  type PathOp,
} from "./path-security.js";
import {
  toolDisabledReason,
  isWritePathTool,
  TERMINAL_TOOLS as CAP_TERMINAL_TOOLS,
  BROWSER_TOOLS as CAP_BROWSER_TOOLS,
  ALL_KNOWN_TOOLS,
} from "./capabilities.js";

/**
 * Policy defaults (blocklist mode for backward compatibility / profile=dev):
 * - command_mode: "blocklist" | "allowlist" (default "blocklist")
 * - blocked_commands: used when command_mode is "blocklist"
 * - allowed_commands: used when command_mode is "allowlist"
 * - terminal_mode: off | allowlist | blocklist | sandbox_fs
 * - trusted_directories: if empty, falls back to allowed_directories (migration)
 *
 * On every readPolicy(), normalizePolicy() applies profile + read_only hard forces.
 */
export const PolicySchema = z.object({
  version: z.number().int().default(2),
  /** Security profile — defaults applied via normalizePolicy. */
  profile: z.enum(["strict", "dev", "locked"]).default("strict"),
  /** When true, Control UI / remote policy edits must be rejected (Agent C lock UI). */
  profile_locked: z.boolean().default(false),
  allowed_directories: z.array(z.string()).default([]),
  /**
   * Trusted roots (S3). If empty, evaluator falls back to allowed_directories.
   */
  trusted_directories: z.array(z.string()).default([]),
  /** Optional separate read roots (S10). If unset, trusted_directories applies. */
  trusted_read_directories: z.array(z.string()).optional(),
  /** Optional separate write roots (S10). If unset, trusted_directories applies. */
  trusted_write_directories: z.array(z.string()).optional(),
  /** Hard deny prefixes (S3). */
  denied_directories: z.array(z.string()).default([]),
  /** User-supplied protected path globs/prefixes (S3), merged with builtins. */
  protected_paths: z.array(z.string()).default([]),
  /**
   * deny_all: protected paths block read+write (strict default).
   * deny_write: only mutate/write blocked (dev default).
   */
  protected_path_policy: z.enum(["deny_all", "deny_write"]).default("deny_write"),
  path_rules: z
    .object({
      symlink_mode: z
        .enum(["deny_escape", "deny_symlinks", "follow"])
        .default("deny_escape"),
      allow_dotdot: z.boolean().default(false),
    })
    .default({}),
  /** Dangerous: disables hardcoded ~/.ssh, .env, etc. protections. */
  disable_builtin_protections: z.boolean().default(false),
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
  /**
   * Terminal containment (S6).
   * off → same as !allow_terminal
   * allowlist / blocklist → command_mode logic
   * sandbox_fs → require bwrap/sandbox-exec or deny TERMINAL_SANDBOX_UNAVAILABLE
   */
  terminal_mode: z
    .enum(["off", "allowlist", "blocklist", "sandbox_fs"])
    .default("blocklist"),
  require_confirmation: z.array(z.string()).default([
    "execute_command",
    "start_job",
    "write_file",
    "edit_file",
    "kill_process",
    "cancel_job",
    "restore_snapshot",
  ]),
  read_only: z.boolean().default(false),
  /**
   * fs_read: only fs_read tools + get_environment (+ list_snapshots)
   * meta_only: only get_environment
   */
  read_only_mode: z.enum(["fs_read", "meta_only"]).default("fs_read"),
  allow_browser: z.boolean().default(false),
  allow_terminal: z.boolean().default(true),
  allow_computer_use: z.boolean().default(false),
  /** When true, execute_command may inject vault secrets via use_secrets. */
  allow_secret_injection: z.boolean().default(true),
  /** When true, daemon may load custom tools from ~/.deckagent/plugins. */
  allow_plugins: z.boolean().default(true),
  /** When true, custom plugins must pin the entry file hash in plugin.json. */
  require_plugin_integrity: z.boolean().default(false),
  max_file_read_size: z.number().int().positive().default(10 * 1024 * 1024),
  max_command_timeout: z.number().int().positive().default(300),
  network: z
    .object({
      allow_browser_hosts: z.array(z.string()).default([]),
      deny_browser_hosts: z.array(z.string()).default([]),
      block_shell_net_tools: z.boolean().default(false),
    })
    .default({}),
  budgets: z
    .object({
      max_tool_calls_per_hour: z.number().int().positive().default(300),
      max_shell_seconds_per_hour: z.number().int().positive().default(600),
      max_bytes_written_per_hour: z.number().int().positive().default(50_000_000),
      max_confirmations_per_hour: z.number().int().positive().default(60),
    })
    .default({}),
});

export type Policy = z.infer<typeof PolicySchema>;

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
  /** Soft error code for tunnel (e.g. ACCESS_DENIED, POLICY_BLOCKED, READ_ONLY). */
  code?: string;
  requiresConfirmation?: boolean;
  confirmationReason?: string;
  /** Hidden execution context for terminal_mode=sandbox_fs. */
  sandbox?: SandboxExecutionContext;
}

export interface SandboxExecutionContext {
  binary: string;
  trusted_dirs: string[];
  network: boolean;
}

/** Active workspace from config (Wave 3 F1). */
export interface WorkspacePolicy {
  root: string;
  name: string;
  allow_outside_with_confirmation: boolean;
}

const TERMINAL_TOOLS = new Set<string>(CAP_TERMINAL_TOOLS);
const BROWSER_TOOLS = new Set<string>(CAP_BROWSER_TOOLS);

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

/** Shell network tools blocked when network.block_shell_net_tools is true (S7). */
const SHELL_NET_TOOLS_PATTERN =
  /\b(curl|wget|nc|ncat|fetch|httpie|ssh|scp|rsync)\b/;

export function getPolicyPath(): string {
  return join(homedir(), ".deckagent", "policy.json");
}

export function createDefaultPolicy(): Policy {
  return normalizePolicy({
    profile: "strict",
    allowed_directories: [],
    trusted_directories: [],
    trusted_read_directories: [],
    trusted_write_directories: [],
    allow_plugins: false,
    allow_secret_injection: false,
    terminal_mode: "allowlist",
    command_mode: "allowlist",
    network: {
      allow_browser_hosts: [],
      deny_browser_hosts: [],
      block_shell_net_tools: true,
    },
    protected_path_policy: "deny_all",
  });
}

/**
 * Normalize raw or partial policy JSON into an effective Policy.
 * Parses via PolicySchema then applies profile + read_only hard forces.
 */
export function normalizePolicy(raw: unknown): Policy {
  const result = PolicySchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new Error(`Invalid policy: ${result.error.message}`);
  }
  return applyNormalizePolicy(result.data);
}

export function readPolicy(path = getPolicyPath()): Policy {
  if (!existsSync(path)) {
    const defaultPolicy = createDefaultPolicy();
    writePolicy(defaultPolicy, path);
    process.stderr.write(
      `[deckagent] WARN Created strict default policy at ${path}; run deckagent policy trust <dir>\n`,
    );
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

  const before = result.data;
  const normalized = applyNormalizePolicy(before);
  const fixes = describeNormalizationFixes(before, normalized);
  if (fixes.length > 0) {
    // Warn on stderr so operators see contradictory JSON was re-forced.
    process.stderr.write(
      `[deckagent] policy normalization: ${fixes.join("; ")}\n`,
    );
  }
  return normalized;
}

export function writePolicy(policy: Policy, path = getPolicyPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const normalized = normalizePolicy(policy);
  const result = PolicySchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(`Cannot write invalid policy: ${result.error.message}`);
  }

  try {
    writeFileSync(path, JSON.stringify(result.data, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    throw new Error(`Failed to write policy file: ${path} (${humanError(err)})`);
  }
}

// Re-export profile helpers + capability / path APIs
export { applyProfileDefaults, describeNormalizationFixes } from "./security-profiles.js";
export {
  getEnabledTools,
  getCapabilities,
  getCapabilityFlags,
  isToolEnabled,
} from "./capabilities.js";
export { evaluatePathAccess } from "./path-security.js";

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

const PATH_ARG_KEYS = ["path", "source", "destination", "workdir", "cwd"] as const;

/**
 * Absolutize path-bearing args before policy checks.
 * Relative paths resolve against workspaceRoot when set; otherwise process.cwd().
 */
export function resolveArgsPaths(
  _tool: string,
  args: Record<string, unknown>,
  workspaceRoot?: string | null,
): Record<string, unknown> {
  const next = { ...args };

  for (const key of PATH_ARG_KEYS) {
    const value = next[key];
    if (typeof value === "string" && value) {
      next[key] = absolutizeToolPath(value, workspaceRoot);
    }
  }

  if (Array.isArray(next.paths)) {
    next.paths = next.paths.map((p) =>
      typeof p === "string" && p ? absolutizeToolPath(p, workspaceRoot) : p,
    );
  }

  return next;
}

/** Expand ~ and resolve relative paths against workspace (or cwd). */
export function absolutizeToolPath(
  inputPath: string,
  workspaceRoot?: string | null,
): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) {
    return resolvePath(trimmed);
  }
  if (workspaceRoot) {
    return resolvePath(workspaceRoot, trimmed);
  }
  return resolvePath(trimmed);
}

/**
 * Returns true if target is the workspace root or a path inside it.
 */
export function isPathInsideWorkspace(
  inputPath: string,
  workspaceRoot: string,
): boolean {
  const resolved = resolvePathWithHome(inputPath);
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    realPath = resolved;
  }

  const normalizedTarget = normalizePathForCompare(realPath);
  const normalizedRoot = normalizePathForCompare(
    resolvePathWithHome(workspaceRoot),
  );

  if (pathsEqual(normalizedTarget, normalizedRoot)) {
    return true;
  }
  return isPathInside(normalizedTarget, normalizedRoot);
}

export function checkToolAllowed(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy,
  workspace?: WorkspacePolicy | null,
  pluginToolNames: readonly string[] = [],
): PolicyResult {
  // Fail closed: always evaluate against normalized effective policy
  const effective = normalizePolicy(policy);

  const allTools = new Set<string>(ALL_KNOWN_TOOLS);
  const pluginTools = new Set<string>(pluginToolNames);
  const isPluginTool = pluginTools.has(toolName);

  if (!allTools.has(toolName) && !isPluginTool) {
    if (!effective.allow_plugins) {
      return {
        allowed: false,
        code: "TOOL_DISABLED",
        reason:
          `[TOOL_DISABLED] Plugin tools are disabled by policy ` +
          `(allow_plugins=false); restart after enabling plugins`,
      };
    }
    return {
      allowed: false,
      code: "TOOL_DISABLED",
      reason: `Unknown tool: ${toolName}`,
    };
  }

  if (isPluginTool) {
    if (!effective.allow_plugins) {
      return {
        allowed: false,
        code: "TOOL_DISABLED",
        reason:
          `[TOOL_DISABLED] Plugin tool '${toolName}' is blocked because ` +
          "policy allow_plugins=false",
      };
    }
    if (effective.require_confirmation.includes(toolName)) {
      return {
        allowed: true,
        requiresConfirmation: true,
        confirmationReason: `Plugin tool '${toolName}' requires confirmation`,
      };
    }
    return { allowed: true };
  }

  // S2 capability gate (includes read_only v2)
  const disabled = toolDisabledReason(toolName, effective);
  if (disabled) {
    return {
      allowed: false,
      code: disabled.code,
      reason: disabled.reason,
    };
  }

  // S6 terminal_mode off (belt + suspenders with capabilities)
  if (
    TERMINAL_TOOLS.has(toolName) &&
    (effective.terminal_mode === "off" || !effective.allow_terminal)
  ) {
    return {
      allowed: false,
      code: effective.read_only ? "READ_ONLY" : "TOOL_DISABLED",
      reason: effective.read_only
        ? `[READ_ONLY] Tool '${toolName}' is blocked because policy is read-only`
        : `[TOOL_DISABLED] Terminal capability is disabled`,
    };
  }

  const argsWithDefaults = applyPathDefaults(toolName, args);
  const resolvedArgs = resolveArgsPaths(
    toolName,
    argsWithDefaults,
    workspace?.root ?? null,
  );

  const terminalSandbox =
    TERMINAL_TOOLS.has(toolName) && effective.terminal_mode === "sandbox_fs"
      ? getSandboxExecutionContext(effective)
      : null;
  if (terminalSandbox && !terminalSandbox.allowed) {
    return terminalSandbox;
  }

  const command =
    typeof resolvedArgs.command === "string" ? resolvedArgs.command : "";
  let sandbox: SandboxExecutionContext | undefined =
    terminalSandbox?.allowed ? terminalSandbox.sandbox : undefined;
  if (command && TERMINAL_TOOLS.has(toolName)) {
    const commandCheck = checkCommandPolicy(command, effective);
    if (!commandCheck.allowed) {
      return commandCheck;
    }
    sandbox = commandCheck.sandbox ?? sandbox;
  }

  // S7 browser URL host checks
  if (toolName === "browser_navigate" || toolName === "browser_evaluate") {
    const url =
      typeof resolvedArgs.url === "string"
        ? resolvedArgs.url
        : typeof resolvedArgs.code === "string"
          ? extractUrlFromExpression(resolvedArgs.code)
          : null;
    if (url) {
      const netCheck = checkBrowserUrlAllowed(url, effective);
      if (!netCheck.allowed) {
        return netCheck;
      }
    } else if (
      toolName === "browser_navigate" &&
      effective.profile === "strict"
    ) {
      // Strict requires a URL we can validate
      const allow = effective.network?.allow_browser_hosts ?? [];
      if (allow.length === 0 || !resolvedArgs.url) {
        return {
          allowed: false,
          code: "NETWORK_DENIED",
          reason:
            "[NETWORK_DENIED] browser_navigate requires an allowed URL host under strict profile",
        };
      }
    }
  }

  // Path engine (S3/S5/S9/S10)
  const pathResult = checkPathAllowed(toolName, resolvedArgs, effective);
  if (!pathResult.allowed) {
    return pathResult;
  }

  const workspaceResult = checkWorkspaceBoundary(resolvedArgs, workspace);
  if (!workspaceResult.allowed) {
    return workspaceResult;
  }

  if (workspaceResult.requiresConfirmation) {
    return {
      allowed: true,
      requiresConfirmation: true,
      confirmationReason:
        workspaceResult.confirmationReason || "Path outside workspace",
      ...(sandbox ? { sandbox } : {}),
    };
  }

  if (effective.require_confirmation.includes(toolName)) {
    const reason = command
      ? `Tool '${toolName}' with command '${command}' requires confirmation`
      : `Tool '${toolName}' requires confirmation`;
    return {
      allowed: true,
      requiresConfirmation: true,
      confirmationReason: reason,
      ...(sandbox ? { sandbox } : {}),
    };
  }

  return { allowed: true, ...(sandbox ? { sandbox } : {}) };
}

/**
 * Enforce workspace boundary after allowlist check.
 * Outside path + allow_outside_with_confirmation → confirmation.
 * Outside path + deny → ACCESS_DENIED.
 */
export function checkWorkspaceBoundary(
  args: Record<string, unknown>,
  workspace?: WorkspacePolicy | null,
): PolicyResult {
  if (!workspace?.root) {
    return { allowed: true };
  }

  const pathsToCheck: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value) {
      pathsToCheck.push(value);
    }
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string" && p) pathsToCheck.push(p);
    }
  }

  for (const p of pathsToCheck) {
    if (isPathInsideWorkspace(p, workspace.root)) {
      continue;
    }

    if (workspace.allow_outside_with_confirmation) {
      return {
        allowed: true,
        requiresConfirmation: true,
        confirmationReason: "Path outside workspace",
      };
    }

    return {
      allowed: false,
      code: "ACCESS_DENIED",
      reason: `ACCESS_DENIED: Path '${p}' is outside workspace '${workspace.root}'`,
    };
  }

  return { allowed: true };
}

/**
 * Apply terminal_mode + command_mode + network.block_shell_net_tools.
 */
export function checkCommandPolicy(
  command: string,
  policy: Policy,
): PolicyResult {
  const effective = normalizePolicy(policy);
  const mode = effective.terminal_mode ?? "blocklist";
  let sandbox: SandboxExecutionContext | undefined;

  if (mode === "off" || !effective.allow_terminal) {
    return {
      allowed: false,
      code: effective.read_only ? "READ_ONLY" : "TOOL_DISABLED",
      reason: `[TOOL_DISABLED] Terminal capability is disabled`,
    };
  }

  if (mode === "sandbox_fs") {
    const sandboxResult = getSandboxExecutionContext(effective);
    if (!sandboxResult.allowed) return sandboxResult;
    sandbox = sandboxResult.sandbox;
    // MVP: once sandbox binary exists, still apply allowlist-style command filter
  }

  // Effective command filter mode
  const commandMode =
    mode === "allowlist" || mode === "sandbox_fs"
      ? "allowlist"
      : effective.command_mode === "allowlist"
        ? "allowlist"
        : "blocklist";

  // When terminal_mode is allowlist, force allowlist filtering even if command_mode says blocklist
  const useAllowlist =
    mode === "allowlist" ||
    mode === "sandbox_fs" ||
    effective.command_mode === "allowlist" ||
    commandMode === "allowlist";

  // S7 block shell net tools (unless explicitly allowlisted by name)
  if (effective.network?.block_shell_net_tools) {
    const normalized = normalizeCommand(command);
    const netMatch = normalized.match(SHELL_NET_TOOLS_PATTERN);
    if (netMatch) {
      const toolName = netMatch[1]!;
      const explicitlyAllowed =
        useAllowlist &&
        effective.allowed_commands.some(
          (e) => normalizeCommand(e) === toolName,
        );
      if (!explicitlyAllowed) {
        return {
          allowed: false,
          code: "NETWORK_DENIED",
          reason: `[NETWORK_DENIED] Shell network tool '${toolName}' is blocked by network.block_shell_net_tools`,
        };
      }
    }
  }

  if (useAllowlist) {
    if (mode !== "sandbox_fs") {
      const inlineEval = findInlineInterpreterEval(command);
      if (inlineEval) {
        return {
          allowed: false,
          code: "COMMAND_BLOCKED",
          reason:
            `[COMMAND_BLOCKED] Inline interpreter execution '${inlineEval}' is blocked ` +
            "under allowlist/strict because it can run arbitrary code; use terminal_mode=sandbox_fs for sandboxed interpreter snippets.",
        };
      }
    }

    if (effective.allowed_commands.length === 0) {
      return {
        allowed: false,
        code: "POLICY_BLOCKED",
        reason:
          "Command blocked by policy: command_mode is allowlist but allowed_commands is empty (all terminal commands blocked)",
      };
    }
    // Still reject known-dangerous patterns even in allowlist mode.
    const dangerous = isCommandBlocked(command, []);
    if (dangerous.blocked) {
      return {
        allowed: false,
        code: "POLICY_BLOCKED",
        reason: `Command blocked by policy: matched dangerous pattern '${dangerous.matched ?? "dangerous pattern"}'`,
      };
    }
    const allowResult = isCommandAllowed(command, effective.allowed_commands);
    if (!allowResult.allowed) {
      return {
        allowed: false,
        code: "POLICY_BLOCKED",
        reason:
          "Command blocked by policy: command_mode is allowlist and command does not match any allowed_commands entry",
      };
    }
    return { allowed: true, ...(sandbox ? { sandbox } : {}) };
  }

  // blocklist (default)
  const blockResult = isCommandBlocked(command, effective.blocked_commands);
  if (blockResult.blocked) {
    return {
      allowed: false,
      code: "POLICY_BLOCKED",
      reason: `Command blocked by policy: matched '${blockResult.matched ?? "dangerous pattern"}'`,
    };
  }
  return { allowed: true, ...(sandbox ? { sandbox } : {}) };
}

function getSandboxExecutionContext(policy: Policy): PolicyResult {
  const binary = findSandboxBinary();
  if (!binary) {
    return {
      allowed: false,
      code: "TERMINAL_SANDBOX_UNAVAILABLE",
      reason:
        "[TERMINAL_SANDBOX_UNAVAILABLE] terminal_mode=sandbox_fs requires bwrap or sandbox-exec (fail closed)",
    };
  }

  return {
    allowed: true,
    sandbox: {
      binary,
      trusted_dirs: getTrustedDirectories(policy, "write").map((dir) =>
        expandAndResolve(dir),
      ),
      network: false,
    },
  };
}

function findInlineInterpreterEval(command: string): string | null {
  const match = command.match(
    /(?:^|[;&|]\s*)(?:env\s+[^;&|]*\s+)?(?:\S*\/)?(python(?:3(?:\.\d+)?)?|node|perl|ruby)\s+(-[^\s]*[ce][^\s]*|--eval\b|--execute\b)/i,
  );
  if (!match) return null;
  return `${match[1]} ${match[2]}`;
}

/**
 * S7: Check browser URL against network allow/deny host lists.
 * Strict: empty allow_browser_hosts → deny all navigations.
 * Dev: empty allow list → allow all (subject to deny list).
 */
export function checkBrowserUrlAllowed(
  urlString: string,
  policy: Policy,
): PolicyResult {
  const effective = normalizePolicy(policy);
  let host: string;
  try {
    const u = new URL(urlString);
    host = u.hostname.toLowerCase();
  } catch {
    return {
      allowed: false,
      code: "NETWORK_DENIED",
      reason: `[NETWORK_DENIED] Invalid URL '${urlString}'`,
    };
  }

  const allow = effective.network?.allow_browser_hosts ?? [];
  const deny = effective.network?.deny_browser_hosts ?? [];

  for (const pattern of deny) {
    if (hostMatches(host, pattern)) {
      return {
        allowed: false,
        code: "NETWORK_DENIED",
        reason: `[NETWORK_DENIED] Host '${host}' is denied by network.deny_browser_hosts`,
      };
    }
  }

  if (allow.length > 0) {
    const ok = allow.some((pattern) => hostMatches(host, pattern));
    if (!ok) {
      return {
        allowed: false,
        code: "NETWORK_DENIED",
        reason: `[NETWORK_DENIED] Host '${host}' is not allowed`,
      };
    }
    return { allowed: true };
  }

  // Empty allow list
  if (effective.profile === "strict") {
    return {
      allowed: false,
      code: "NETWORK_DENIED",
      reason: `[NETWORK_DENIED] Host '${host}' is not allowed (strict profile requires allow_browser_hosts)`,
    };
  }

  return { allowed: true };
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // .example.com
    return host.endsWith(suffix) || host === p.slice(2);
  }
  return host === p;
}

function extractUrlFromExpression(expression: string): string | null {
  const m = expression.match(/https?:\/\/[^\s'"`]+/i);
  return m ? m[0]! : null;
}

function checkPathAllowed(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy,
): PolicyResult {
  const op: PathOp = isWritePathTool(toolName) ? "write" : "read";
  const pathKeys = ["path", "source", "destination", "workdir", "cwd"];

  for (const key of pathKeys) {
    const value = args[key];
    if (typeof value !== "string" || !value) continue;

    // move_file: both source and destination checked as write (mutating)
    const keyOp: PathOp =
      toolName === "move_file"
        ? "write"
        : key === "workdir" || key === "cwd"
          ? "read"
          : op;

    const result = evaluatePathAccess(value, keyOp, policy);
    if (!result.allowed) {
      return {
        allowed: false,
        code: result.code,
        reason: result.reason,
      };
    }
  }

  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p !== "string") continue;
      const result = evaluatePathAccess(p, op, policy);
      if (!result.allowed) {
        return {
          allowed: false,
          code: result.code,
          reason: result.reason,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Legacy helper: true if path is inside trusted roots (read op, no protected deny for deny_write reads).
 */
export function isPathAllowed(inputPath: string, policy: Policy): boolean {
  const effective = normalizePolicy(policy);
  const result = evaluatePathAccess(inputPath, "read", effective);
  return result.allowed;
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
