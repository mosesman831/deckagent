/**
 * Capability → tool enablement (S2) + read_only v2 filtering.
 * Used by checkToolAllowed, tools/list projection, and policy_caps.
 */
import type { Policy } from "./policy.js";

/** Names must stay in sync with packages/cloudflare-worker TOOL_CATALOG. */
export const ALL_KNOWN_TOOLS: readonly string[] = [
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
  "list_snapshots",
  "restore_snapshot",
] as const;

export const ALL_CATALOG_TOOLS = ALL_KNOWN_TOOLS;

export const FS_READ_TOOLS: readonly string[] = [
  "read_file",
  "read_multiple_files",
  "list_directory",
  "get_file_info",
  "search_files",
  "list_snapshots",
];

export const FS_WRITE_TOOLS: readonly string[] = [
  "write_file",
  "edit_file",
  "create_directory",
  "move_file",
  "restore_snapshot",
];

export const TERMINAL_TOOLS: readonly string[] = [
  "execute_command",
  "execute_command_stream",
  "list_processes",
  "kill_process",
];

export const BROWSER_TOOLS: readonly string[] = [
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_evaluate",
];

export const META_TOOLS: readonly string[] = ["get_environment"];

const FS_READ_SET = new Set(FS_READ_TOOLS);
const FS_WRITE_SET = new Set(FS_WRITE_TOOLS);
const TERMINAL_SET = new Set(TERMINAL_TOOLS);
const BROWSER_SET = new Set(BROWSER_TOOLS);
const META_SET = new Set(META_TOOLS);

export type CapabilityFlags = {
  fs_read: boolean;
  fs_write: boolean;
  terminal: boolean;
  browser: boolean;
  meta: boolean;
};

/** Alias used by ToolExecutor. */
export type Capabilities = CapabilityFlags;

export function isWritePathTool(toolName: string): boolean {
  return FS_WRITE_SET.has(toolName);
}

export function getCapabilities(policy: Policy): Capabilities {
  if (policy.read_only && policy.read_only_mode === "meta_only") {
    return {
      fs_read: false,
      fs_write: false,
      terminal: false,
      browser: false,
      meta: true,
    };
  }

  if (policy.read_only) {
    return {
      fs_read: true,
      fs_write: false,
      terminal: false,
      browser: false,
      meta: true,
    };
  }

  const terminalOn =
    policy.allow_terminal && policy.terminal_mode !== "off";

  return {
    fs_read: true,
    fs_write: true,
    terminal: terminalOn,
    browser: policy.allow_browser,
    meta: true,
  };
}

/** Alias for Worker / index.ts policy_caps payload. */
export function getCapabilityFlags(policy: Policy): CapabilityFlags {
  return getCapabilities(policy);
}

export function isToolEnabled(toolName: string, policy: Policy): boolean {
  return toolDisabledReason(toolName, policy) === null;
}

/**
 * Return tool names the daemon currently allows (for tools/list / policy_caps).
 */
export function getEnabledTools(policy: Policy): string[] {
  return ALL_KNOWN_TOOLS.filter((t) => isToolEnabled(t, policy));
}

/**
 * If the tool is disabled by capability matrix, return a deny payload.
 * Null means the tool is capability-enabled (path/command checks may still deny).
 */
export function toolDisabledReason(
  toolName: string,
  policy: Policy,
): { code: string; reason: string } | null {
  const caps = getCapabilities(policy);

  if (META_SET.has(toolName)) {
    return caps.meta
      ? null
      : {
          code: "TOOL_DISABLED",
          reason: `[TOOL_DISABLED] Tool '${toolName}' is not enabled by current policy`,
        };
  }

  if (policy.read_only && policy.read_only_mode === "meta_only") {
    return {
      code: "READ_ONLY",
      reason: `[READ_ONLY] Tool '${toolName}' is blocked because policy is meta_only read-only`,
    };
  }

  if (FS_READ_SET.has(toolName)) {
    return caps.fs_read
      ? null
      : {
          code: "READ_ONLY",
          reason: `[READ_ONLY] Tool '${toolName}' is blocked because policy is read-only`,
        };
  }

  if (FS_WRITE_SET.has(toolName)) {
    if (!caps.fs_write) {
      return {
        code: policy.read_only ? "READ_ONLY" : "TOOL_DISABLED",
        reason: policy.read_only
          ? `[READ_ONLY] Tool '${toolName}' is blocked because policy is read-only`
          : `[TOOL_DISABLED] Tool '${toolName}' is not enabled by current policy`,
      };
    }
    return null;
  }

  if (TERMINAL_SET.has(toolName)) {
    if (!caps.terminal) {
      return {
        code: policy.read_only ? "READ_ONLY" : "TOOL_DISABLED",
        reason: policy.read_only
          ? `[READ_ONLY] Tool '${toolName}' is blocked because policy is read-only`
          : `[TOOL_DISABLED] Terminal capability is disabled`,
      };
    }
    return null;
  }

  if (BROWSER_SET.has(toolName)) {
    if (!caps.browser) {
      return {
        code: policy.read_only ? "READ_ONLY" : "TOOL_DISABLED",
        reason: policy.read_only
          ? `[READ_ONLY] Tool '${toolName}' is blocked because policy is read-only`
          : `[TOOL_DISABLED] Browser tools are disabled by policy`,
      };
    }
    return null;
  }

  return {
    code: "TOOL_DISABLED",
    reason: `[TOOL_DISABLED] Unknown or disabled tool '${toolName}'`,
  };
}
