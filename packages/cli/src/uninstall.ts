import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  askYesNo,
  getConfigDir,
  getLogDir,
  readConfig as readConfigFile,
  type Config
} from './configure.js';
import { resolveWorkerPackageDir } from './deploy-worker.js';
import { uninstallDaemonService as uninstallDaemonServiceDefault } from './install-daemon.js';

export interface UninstallFlags {
  dryRun: boolean;
  keepConfig: boolean;
  keepLogs: boolean;
  deleteWorker: boolean;
  unregisterDevice: boolean;
  yes: boolean;
}

export interface UninstallPlan {
  flags: UninstallFlags;
  configDir: string;
  logDir: string;
  pathsToRemove: string[];
  servicePaths: string[];
  retainedPaths: string[];
  networkActions: string[];
  warnings: string[];
}

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
  }
) => Promise<Response>;

export interface UninstallOptions {
  configDir?: string;
  logDir?: string;
  readConfig?: () => Config;
  uninstallDaemonService?: () => void;
  deleteWorker?: () => void;
  promptConfirm?: (message: string) => Promise<boolean>;
  fetch?: FetchLike;
  writeLine?: (line: string) => void;
}

const DEFAULT_FLAGS: UninstallFlags = {
  dryRun: false,
  keepConfig: false,
  keepLogs: false,
  deleteWorker: false,
  unregisterDevice: false,
  yes: false
};

export function parseUninstallFlags(args: string[]): UninstallFlags {
  const flags = { ...DEFAULT_FLAGS };
  for (const arg of args) {
    switch (arg) {
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--keep-config':
        flags.keepConfig = true;
        break;
      case '--keep-logs':
        flags.keepLogs = true;
        break;
      case '--delete-worker':
        flags.deleteWorker = true;
        break;
      case '--unregister-device':
        flags.unregisterDevice = true;
        break;
      case '--yes':
      case '-y':
        flags.yes = true;
        break;
      case 'help':
      case '--help':
      case '-h':
        throw new Error(uninstallHelp());
      default:
        throw new Error(`Unknown uninstall option: ${arg}`);
    }
  }
  return flags;
}

export function uninstallHelp(): string {
  return `Usage:
  deckagent uninstall [--dry-run] [--keep-config] [--keep-logs] [--delete-worker] [--unregister-device] [--yes]

Options:
  --dry-run            Print the uninstall plan and make no changes
  --keep-config        Keep config, policy, secrets, snapshots, and other ~/.deckagent data
  --keep-logs          Keep ~/.deckagent/logs
  --delete-worker      Delete the Cloudflare Worker with wrangler
  --unregister-device  DELETE this device from the Worker device registry
  --yes, -y            Skip interactive confirmation after printing the plan`;
}

function servicePathsForPlatform(configDir: string): string[] {
  const platform = os.platform();
  if (platform === 'darwin') {
    return [path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deckagent.daemon.plist')];
  }
  if (platform === 'linux') {
    return [path.join(os.homedir(), '.config', 'systemd', 'user', 'deckagent-daemon.service')];
  }
  if (platform === 'win32') {
    return [path.join(configDir, 'start-daemon.cmd'), 'Windows scheduled task: DeckAgentDaemon'];
  }
  return [];
}

function listConfigEntriesExceptLogs(configDir: string, logDir: string): string[] {
  if (!fs.existsSync(configDir)) {
    return [configDir];
  }
  const resolvedLogDir = path.resolve(logDir);
  return fs
    .readdirSync(configDir)
    .map((entry) => path.join(configDir, entry))
    .filter((entryPath) => path.resolve(entryPath) !== resolvedLogDir);
}

function listConfigRemovalPaths(configDir: string): string[] {
  if (!fs.existsSync(configDir)) {
    return [configDir];
  }
  return [
    configDir,
    ...fs.readdirSync(configDir).map((entry) => path.join(configDir, entry))
  ];
}

function tryReadConfig(readConfig: () => Config): Config | null {
  try {
    return readConfig();
  } catch {
    return null;
  }
}

export function buildUninstallPlan(
  flags: UninstallFlags,
  options: UninstallOptions = {}
): UninstallPlan {
  const configDir = options.configDir ?? getConfigDir();
  const logDir = options.logDir ?? getLogDir();
  const readConfig = options.readConfig ?? readConfigFile;
  const pathsToRemove: string[] = [];
  const retainedPaths: string[] = [];
  const networkActions: string[] = [];
  const warnings: string[] = [];

  if (flags.keepConfig) {
    retainedPaths.push(configDir);
  } else if (flags.keepLogs) {
    pathsToRemove.push(...listConfigEntriesExceptLogs(configDir, logDir));
    retainedPaths.push(logDir);
  } else {
    pathsToRemove.push(...listConfigRemovalPaths(configDir));
  }

  if (flags.keepLogs && !retainedPaths.includes(logDir)) {
    retainedPaths.push(logDir);
  } else if (flags.keepConfig && !flags.keepLogs) {
    pathsToRemove.push(logDir);
  }

  if (flags.unregisterDevice) {
    const config = tryReadConfig(readConfig);
    if (config) {
      const url = new URL(`/api/devices/${encodeURIComponent(config.device_id)}`, config.worker_url);
      networkActions.push(`DELETE ${url.toString()} (Bearer token)`);
    } else {
      warnings.push('Cannot plan device unregister: config.json is missing or invalid.');
    }
  }

  if (flags.deleteWorker) {
    networkActions.push('Delete Cloudflare Worker using `npx wrangler delete --force`');
  }

  return {
    flags,
    configDir,
    logDir,
    pathsToRemove: [...new Set(pathsToRemove)],
    servicePaths: servicePathsForPlatform(configDir),
    retainedPaths: [...new Set(retainedPaths)],
    networkActions,
    warnings
  };
}

export function printUninstallPlan(
  plan: UninstallPlan,
  writeLine: (line: string) => void = (line) => console.log(line)
): void {
  writeLine('DeckAgent uninstall plan:');
  writeLine('  Actions:');
  writeLine('    - Stop daemon and remove user service registration');
  for (const action of plan.networkActions) {
    writeLine(`    - ${action}`);
  }

  writeLine('  Service paths/tasks that may be removed:');
  if (plan.servicePaths.length === 0) {
    writeLine('    - (none for this platform)');
  } else {
    for (const servicePath of plan.servicePaths) {
      writeLine(`    - ${servicePath}`);
    }
  }

  writeLine('  Paths that may be removed:');
  if (plan.pathsToRemove.length === 0) {
    writeLine('    - (none)');
  } else {
    for (const removePath of plan.pathsToRemove) {
      writeLine(`    - ${removePath}`);
    }
  }

  if (plan.retainedPaths.length > 0) {
    writeLine('  Paths retained:');
    for (const retainedPath of plan.retainedPaths) {
      writeLine(`    - ${retainedPath}`);
    }
  }

  for (const warning of plan.warnings) {
    writeLine(`  Warning: ${warning}`);
  }

  if (plan.flags.dryRun) {
    writeLine('Dry run: no changes will be made.');
  }
}

function removeConfiguredPaths(plan: UninstallPlan): void {
  if (plan.flags.keepConfig && plan.flags.keepLogs) {
    return;
  }

  if (!plan.flags.keepConfig && !plan.flags.keepLogs) {
    if (fs.existsSync(plan.configDir)) {
      fs.rmSync(plan.configDir, { recursive: true, force: true });
    }
    return;
  }

  if (!plan.flags.keepConfig && plan.flags.keepLogs) {
    for (const removePath of listConfigEntriesExceptLogs(plan.configDir, plan.logDir)) {
      if (fs.existsSync(removePath)) {
        fs.rmSync(removePath, { recursive: true, force: true });
      }
    }
    return;
  }

  if (plan.flags.keepConfig && !plan.flags.keepLogs && fs.existsSync(plan.logDir)) {
    fs.rmSync(plan.logDir, { recursive: true, force: true });
  }
}

function getFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch !== 'function') {
    throw new Error('Device unregister requires Node.js fetch support. Use Node 18 or newer.');
  }
  return fetch;
}

export async function unregisterConfiguredDevice(
  config: Config,
  fetchImpl: FetchLike = getFetch()
): Promise<void> {
  const url = new URL(`/api/devices/${encodeURIComponent(config.device_id)}`, config.worker_url);
  const response = await fetchImpl(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${config.api_token}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    let message = `Device unregister failed with HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text.trim()) {
        message = `Device unregister failed (${response.status}): ${text}`;
      }
    } catch {
      // Keep the status-only message.
    }
    throw new Error(message);
  }
}

function deleteCloudflareWorker(): void {
  const workerDir = resolveWorkerPackageDir();
  execSync('npx wrangler delete --force', { cwd: workerDir, stdio: 'inherit' });
}

export async function runUninstall(
  args: string[],
  options: UninstallOptions = {}
): Promise<void> {
  const writeLine = options.writeLine ?? ((line: string) => console.log(line));
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    writeLine(uninstallHelp());
    return;
  }

  const flags = parseUninstallFlags(args);
  const readConfig = options.readConfig ?? readConfigFile;
  const plan = buildUninstallPlan(flags, { ...options, readConfig });
  printUninstallPlan(plan, writeLine);

  if (flags.dryRun) {
    return;
  }

  const promptConfirm = options.promptConfirm ?? askYesNo;
  if (!flags.yes) {
    const confirmed = await promptConfirm('Proceed with uninstall?');
    if (!confirmed) {
      writeLine('Uninstall cancelled.');
      return;
    }
  }

  if (flags.unregisterDevice) {
    const config = readConfig();
    await unregisterConfiguredDevice(config, getFetch(options.fetch));
    writeLine(`Unregistered device ${config.device_id}.`);
  }

  const uninstallDaemonService = options.uninstallDaemonService ?? uninstallDaemonServiceDefault;
  uninstallDaemonService();

  if (flags.deleteWorker) {
    const deleteWorker = options.deleteWorker ?? deleteCloudflareWorker;
    try {
      deleteWorker();
      writeLine('Cloudflare Worker delete requested.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeLine(`Could not delete Cloudflare Worker: ${message}`);
    }
  }

  removeConfiguredPaths(plan);
  writeLine('DeckAgent uninstalled.');
}
