import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

/** Tool-name groupings used by policy checks (SPEC §3.6, §4). */
export const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_evaluate',
] as const;

export const TERMINAL_TOOLS = [
  'execute_command',
  'execute_command_stream',
  'list_processes',
  'kill_process',
] as const;

/** Tools that mutate the system and are blocked in read-only mode. */
export const WRITE_TOOLS = [
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
  'kill_process',
] as const;

export const PolicySchema = z.object({
  version: z.number().default(1),
  allowed_directories: z.array(z.string()).default(['~']),
  blocked_commands: z.array(z.string()).default(['rm -rf', 'sudo', 'su', 'passwd']),
  require_confirmation: z.array(z.string()).default(['kill_process', 'move_file']),
  read_only: z.boolean().default(false),
  allow_browser: z.boolean().default(true),
  allow_terminal: z.boolean().default(true),
  allow_computer_use: z.boolean().default(false),
  max_file_read_size: z.number().default(10485760),
  max_command_timeout: z.number().default(300),
});

export type Policy = z.infer<typeof PolicySchema>;

/** The default policy written when none exists (SPEC §3.6). */
export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

/** Root DeckAgent directory: `~/.deckagent`. */
function getConfigDir(): string {
  return path.join(os.homedir(), '.deckagent');
}

/** Absolute path to the policy file: `~/.deckagent/policy.json`. */
export function getPolicyPath(): string {
  return path.join(getConfigDir(), 'policy.json');
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Load `~/.deckagent/policy.json`. If it does not exist, the default policy is
 * written to disk and returned. Invalid policies throw a human-readable error.
 */
export function loadPolicy(): Policy {
  const policyPath = getPolicyPath();
  if (!fs.existsSync(policyPath)) {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n', 'utf8');
    return DEFAULT_POLICY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (err) {
    throw new Error(`Policy at ${policyPath} is not valid JSON: ${(err as Error).message}`);
  }

  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Policy at ${policyPath} is invalid:\n${issues}`);
  }
  return result.data;
}

/**
 * Resolve each entry in `allowed_directories`: expand `~`, make absolute, and
 * resolve symlinks via `fs.realpathSync` when the directory exists. Entries that
 * cannot be resolved fall back to their absolute form.
 */
export function resolveAllowedDirectories(allowedDirectories: string[]): string[] {
  return allowedDirectories.map((dir) => {
    const absolute = path.resolve(expandHome(dir));
    try {
      return fs.realpathSync(absolute);
    } catch {
      return absolute;
    }
  });
}

/**
 * True if `candidate` is inside one of `allowedDirectories`. Symlinks are
 * resolved (to prevent escapes) and comparison is path-separator aware so
 * `/foo` does not match `/foobar`. An empty list means "no restriction".
 */
export function isPathAllowed(candidate: string, allowedDirectories: string[]): boolean {
  if (!allowedDirectories || allowedDirectories.length === 0) return true;

  const resolvedCandidate = resolveExisting(path.resolve(expandHome(candidate)));
  const resolvedAllowed = resolveAllowedDirectories(allowedDirectories);
  const root = path.parse(resolvedCandidate).root;

  return resolvedAllowed.some((allowed) => {
    if (allowed === root) return true;
    if (resolvedCandidate === allowed) return true;
    const withSep = allowed.endsWith(path.sep) ? allowed : allowed + path.sep;
    return resolvedCandidate.startsWith(withSep);
  });
}

/** Resolve symlinks for a path, walking up to the deepest existing ancestor. */
function resolveExisting(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True if `command` contains any blocked substring (case-insensitive). */
export function isCommandBlocked(command: string, blockedCommands: string[]): boolean {
  const lower = command.toLowerCase();
  return blockedCommands.some((blocked) => lower.includes(blocked.toLowerCase()));
}

/** True if `tool` is in the confirmation-required list. */
export function needsConfirmation(tool: string, requireConfirmation: string[]): boolean {
  return requireConfirmation.includes(tool);
}

/** Collect path-like values from tool args (path, source, destination, paths[]). */
function extractPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ['path', 'source', 'destination']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) paths.push(value);
  }
  if (Array.isArray(args.paths)) {
    for (const value of args.paths) {
      if (typeof value === 'string' && value.length > 0) paths.push(value);
    }
  }
  return paths;
}

/**
 * Validate a tool call against the policy. Returns `{ allowed: true }` or
 * `{ allowed: false, reason }`. Order of checks (SPEC §3.5/§3.6):
 *   1. read_only blocks mutating tools
 *   2. allow_browser / allow_terminal gates
 *   3. blocked_commands for execute_command / execute_command_stream
 *   4. allowed_directories for any tool with a path/source/destination
 *   5. require_confirmation list
 */
export function validateToolCall(
  tool: string,
  args: Record<string, unknown>,
  policy: Policy,
): ValidationResult {
  if (policy.read_only && (WRITE_TOOLS as readonly string[]).includes(tool)) {
    return { allowed: false, reason: `Tool '${tool}' is disabled: policy is read-only.` };
  }

  if (!policy.allow_browser && (BROWSER_TOOLS as readonly string[]).includes(tool)) {
    return { allowed: false, reason: `Browser tools are disabled by policy.` };
  }

  if (!policy.allow_terminal && (TERMINAL_TOOLS as readonly string[]).includes(tool)) {
    return { allowed: false, reason: `Terminal tools are disabled by policy.` };
  }

  if (tool === 'execute_command' || tool === 'execute_command_stream') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (isCommandBlocked(command, policy.blocked_commands)) {
      return { allowed: false, reason: `Command blocked by policy: '${command}'.` };
    }
  }

  for (const candidate of extractPaths(args)) {
    if (!isPathAllowed(candidate, policy.allowed_directories)) {
      return {
        allowed: false,
        reason: `Access denied: '${candidate}' is outside the allowed directories.`,
      };
    }
  }

  if (needsConfirmation(tool, policy.require_confirmation)) {
    return { allowed: false, reason: `Tool '${tool}' requires user confirmation.` };
  }

  return { allowed: true };
}
