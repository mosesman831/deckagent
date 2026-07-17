import { z } from "zod";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";

export const PolicySchema = z.object({
  version: z.number().int().default(1),
  allowed_directories: z.array(z.string()).default(["~"]),
  blocked_commands: z.array(z.string()).default([
    "rm -rf",
    "sudo",
    "shutdown",
    "reboot",
    "poweroff",
    "init",
    "dd",
    "mkfs",
  ]),
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

export function checkToolAllowed(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy,
  preconfirmed = false,
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
    return { allowed: false, reason: `Tool '${toolName}' is blocked because policy is read-only` };
  }

  if (!policy.allow_terminal && TERMINAL_TOOLS.has(toolName)) {
    return { allowed: false, reason: `Terminal tools are disabled by policy` };
  }

  if (!policy.allow_browser && BROWSER_TOOLS.has(toolName)) {
    return { allowed: false, reason: `Browser tools are disabled by policy` };
  }

  const command = typeof args.command === "string" ? args.command : "";
  if (command) {
    const lowerCommand = command.toLowerCase();
    for (const blocked of policy.blocked_commands) {
      if (lowerCommand.includes(blocked.toLowerCase())) {
        return {
          allowed: false,
          reason: `Command blocked by policy: '${blocked}' is not allowed`,
        };
      }
    }
  }

  const pathResult = checkPathAllowed(toolName, args, policy);
  if (!pathResult.allowed) {
    return pathResult;
  }

  if (!preconfirmed && policy.require_confirmation.includes(toolName)) {
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

function checkPathAllowed(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy,
): PolicyResult {
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

function isPathAllowed(inputPath: string, policy: Policy): boolean {
  const resolved = resolvePathWithHome(inputPath);
  let realPath: string;

  try {
    realPath = realpathSync(resolved);
  } catch {
    realPath = resolved;
  }

  if (!isAbsolute(realPath)) {
    return false;
  }

  const allowedDirs = policy.allowed_directories.map((d) =>
    resolvePathWithHome(d),
  );

  for (const allowed of allowedDirs) {
    const normalizedAllowed = allowed.endsWith("/") ? allowed : allowed + "/";
    if (realPath === allowed || realPath.startsWith(normalizedAllowed)) {
      return true;
    }
  }

  return false;
}

function resolvePathWithHome(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return join(homedir(), inputPath.slice(2));
  }
  if (inputPath === "~") {
    return homedir();
  }
  return resolvePath(inputPath);
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
