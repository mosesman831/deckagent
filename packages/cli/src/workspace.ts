import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readConfig,
  writeConfig,
  readPolicy,
  writePolicy,
  configExists,
  type Policy,
  type Workspace
} from './configure.js';

/**
 * Expand `~` / `~/...` and resolve to an absolute path.
 * Throws a human-readable error if the path does not exist or is not a directory.
 */
export function resolveWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Workspace path is required. Usage: deckagent workspace use <path>');
  }

  let expanded: string;
  if (trimmed === '~') {
    expanded = os.homedir();
  } else if (trimmed.startsWith('~/') || trimmed.startsWith('~' + path.sep)) {
    expanded = path.join(os.homedir(), trimmed.slice(2));
  } else {
    expanded = path.resolve(trimmed);
  }

  const absPath = path.resolve(expanded);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Workspace path does not exist: ${absPath}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    throw new Error(
      `Cannot access workspace path: ${absPath} (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${absPath}`);
  }

  return absPath;
}

/** Normalize for prefix comparison (absolute, no trailing separator except root). */
function normalizeForPrefix(inputPath: string): string {
  let expanded = inputPath.trim();
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~' + path.sep)) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  let normalized = path.resolve(expanded);
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  if (normalized.length > 1 && (normalized.endsWith(path.sep) || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Returns true if `root` is already covered by an allowed directory
 * (exact match or allowed dir is a path prefix of root).
 */
export function isCoveredByAllowedDirectory(root: string, allowedDirectories: string[]): boolean {
  const normalizedRoot = normalizeForPrefix(root);
  for (const dir of allowedDirectories) {
    const normalizedDir = normalizeForPrefix(dir);
    if (normalizedRoot === normalizedDir) {
      return true;
    }
    const prefix = normalizedDir.endsWith(path.sep) ? normalizedDir : normalizedDir + path.sep;
    if (normalizedRoot.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Ensure `root` is covered by policy.allowed_directories.
 * If no allowed dir is a prefix of root, push root onto the list.
 * Returns the (possibly updated) policy and whether it was mutated.
 */
export function ensureAllowedDirectory(
  policy: Policy,
  root: string
): { policy: Policy; added: boolean } {
  if (isCoveredByAllowedDirectory(root, policy.allowed_directories)) {
    return { policy, added: false };
  }
  return {
    policy: {
      ...policy,
      allowed_directories: [...policy.allowed_directories, root]
    },
    added: true
  };
}

function printWorkspaceSummary(workspace: Workspace, extraNote?: string): void {
  console.log('Workspace:');
  console.log(`  root: ${workspace.root}`);
  console.log(`  name: ${workspace.name}`);
  console.log(
    `  allow_outside_with_confirmation: ${workspace.allow_outside_with_confirmation}`
  );
  if (extraNote) {
    console.log(`  note: ${extraNote}`);
  }
}

export function workspaceUse(inputPath: string): void {
  if (!configExists()) {
    throw new Error("Config not found. Run 'deckagent setup' first.");
  }

  const absPath = resolveWorkspacePath(inputPath);
  const workspace: Workspace = {
    root: absPath,
    name: path.basename(absPath),
    allow_outside_with_confirmation: true
  };

  const config = readConfig();
  writeConfig({ ...config, workspace });

  let addedToPolicy = false;
  try {
    const policy = readPolicy();
    const { policy: updated, added } = ensureAllowedDirectory(policy, absPath);
    if (added) {
      writePolicy(updated);
      addedToPolicy = true;
    }
  } catch (err) {
    console.warn(
      `Warning: could not update policy.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  printWorkspaceSummary(
    workspace,
    'Restart the daemon if it is running so it picks up the new workspace config.'
  );
  if (addedToPolicy) {
    console.log(`  policy: added ${absPath} to allowed_directories`);
  }
}

export function workspaceStatus(): void {
  if (!configExists()) {
    console.log('No workspace set');
    return;
  }

  const config = readConfig();
  if (!config.workspace) {
    console.log('No workspace set');
    return;
  }

  printWorkspaceSummary(config.workspace);
}

export function workspaceClear(): void {
  if (!configExists()) {
    throw new Error("Config not found. Run 'deckagent setup' first.");
  }

  const config = readConfig();
  if (!config.workspace) {
    console.log('No workspace was set.');
    return;
  }

  const { workspace: _removed, ...rest } = config;
  writeConfig(rest);
  console.log('Workspace cleared.');
}

export function runWorkspaceCommand(args: string[]): void {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(`Usage:
  deckagent workspace use <path>   Set active workspace root
  deckagent workspace status       Show current workspace
  deckagent workspace clear        Clear workspace from config
`);
    return;
  }

  switch (sub) {
    case 'use': {
      const pathArg = args[1];
      if (!pathArg) {
        throw new Error('Missing path. Usage: deckagent workspace use <path>');
      }
      workspaceUse(pathArg);
      break;
    }
    case 'status': {
      workspaceStatus();
      break;
    }
    case 'clear': {
      workspaceClear();
      break;
    }
    default:
      throw new Error(
        `Unknown workspace command: ${sub}. Use: use | status | clear`
      );
  }
}
