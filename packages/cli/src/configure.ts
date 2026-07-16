import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { z } from 'zod';

export const ConfigSchema = z.object({
  device_id: z.string().uuid(),
  token: z.string().min(32),
  worker_url: z.string().url(),
  device_name: z.string().min(1),
  api_token: z.string().min(32),
  heartbeat_interval: z.number().int().default(15),
  tool_timeout: z.number().int().default(60),
  auto_connect: z.boolean().default(true),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});

export const DEFAULT_REQUIRE_CONFIRMATION = [
  'execute_command',
  'write_file',
  'edit_file',
  'move_file',
  'kill_process'
] as const;

export const DEFAULT_BLOCKED_COMMANDS = [
  'rm -rf',
  'sudo',
  'shutdown',
  'reboot',
  'poweroff',
  'init',
  'dd',
  'mkfs'
] as const;

export const PolicySchema = z.object({
  version: z.number().int().default(1),
  allowed_directories: z.array(z.string()).default([]),
  blocked_commands: z.array(z.string()).default([...DEFAULT_BLOCKED_COMMANDS]),
  require_confirmation: z.array(z.string()).default([...DEFAULT_REQUIRE_CONFIRMATION]),
  read_only: z.boolean().default(false),
  // true: setup registers browser capabilities; daemon schema defaults false until policy is written
  allow_browser: z.boolean().default(true),
  allow_terminal: z.boolean().default(true),
  allow_computer_use: z.boolean().default(false),
  command_mode: z.enum(['blocklist', 'allowlist']).default('blocklist'),
  allowed_commands: z.array(z.string()).default([]),
  max_file_read_size: z.number().int().default(10 * 1024 * 1024),
  max_command_timeout: z.number().int().default(300)
});

export type Config = z.infer<typeof ConfigSchema>;
export type Policy = z.infer<typeof PolicySchema>;

export function getConfigDir(): string {
  const home = os.homedir();
  return path.join(home, '.deckagent');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function getPolicyPath(): string {
  return path.join(getConfigDir(), 'policy.json');
}

export function getLogDir(): string {
  return path.join(getConfigDir(), 'logs');
}

export function ensureConfigDir(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.mkdirSync(getLogDir(), { recursive: true });
}

export function generateConfig(deviceId: string, token: string, workerUrl: string, apiToken: string): Config {
  const hostname = os.hostname();
  return {
    device_id: deviceId,
    token,
    worker_url: workerUrl,
    device_name: hostname,
    api_token: apiToken,
    heartbeat_interval: 15,
    tool_timeout: 60,
    auto_connect: true,
    log_level: 'info'
  };
}

/**
 * Safer defaults for strangers: Documents + Desktop when present, else ~/DeckAgent.
 * Never defaults to full $HOME.
 */
export function getDefaultAllowedDirectories(): string[] {
  const home = os.homedir();
  const documents = path.join(home, 'Documents');
  const desktop = path.join(home, 'Desktop');
  const dirs: string[] = [];

  if (fs.existsSync(documents)) {
    dirs.push(documents);
  }
  if (fs.existsSync(desktop)) {
    dirs.push(desktop);
  }

  if (dirs.length === 0) {
    const deckAgentDir = path.join(home, 'DeckAgent');
    fs.mkdirSync(deckAgentDir, { recursive: true });
    dirs.push(deckAgentDir);
  }

  return dirs;
}

export function generateDefaultPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    allowed_directories: getDefaultAllowedDirectories(),
    blocked_commands: [...DEFAULT_BLOCKED_COMMANDS],
    require_confirmation: [...DEFAULT_REQUIRE_CONFIRMATION],
    read_only: false,
    allow_browser: true,
    allow_terminal: true,
    allow_computer_use: false,
    command_mode: 'blocklist',
    allowed_commands: [],
    max_file_read_size: 10 * 1024 * 1024,
    max_command_timeout: 300,
    ...overrides
  };
}

function writeSecureJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on some Windows setups; mode on create is best-effort there.
  }
}

export function writeConfigFiles(config: Config, policy: Policy): void {
  ensureConfigDir();
  writeSecureJson(getConfigPath(), config);
  writeSecureJson(getPolicyPath(), policy);
}

export function readConfig(): Config {
  const raw = fs.readFileSync(getConfigPath(), 'utf-8');
  return ConfigSchema.parse(JSON.parse(raw));
}

export function readPolicy(): Policy {
  const raw = fs.readFileSync(getPolicyPath(), 'utf-8');
  return PolicySchema.parse(JSON.parse(raw));
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

export function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Yes/no prompt. Empty answer uses defaultYes (false → N, true → Y).
 */
export function askYesNo(query: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? '(Y/n)' : '(y/N)';
  return askQuestion(`${query} ${hint}: `).then((answer) => {
    if (!answer) return defaultYes;
    const normalized = answer.toLowerCase();
    if (normalized === 'y' || normalized === 'yes') return true;
    if (normalized === 'n' || normalized === 'no') return false;
    return defaultYes;
  });
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function printSecuritySummary(policy: Policy): void {
  console.log('--- Security summary ---');
  console.log(`  Allowed directories: ${policy.allowed_directories.join(', ') || '(none)'}`);
  console.log(`  Read-only mode:     ${policy.read_only ? 'ON' : 'OFF'}`);
  console.log(`  Terminal tools:     ${policy.allow_terminal ? 'allowed' : 'disabled'}`);
  console.log(`  Browser tools:      ${policy.allow_browser ? 'allowed' : 'disabled'}`);
  console.log(
    `  Confirm mutations:  ${
      policy.require_confirmation.length > 0
        ? `ON (${policy.require_confirmation.join(', ')})`
        : 'OFF'
    }`
  );
  console.log(`  Blocked commands:   ${policy.blocked_commands.join(', ')}`);
  console.log(`  Policy file:        ${getPolicyPath()} (mode 0600)`);
  console.log('');
}

/**
 * Interactive first-run policy prompts with stranger-safe defaults.
 */
export async function promptForPolicy(): Promise<Policy> {
  console.log('\n--- Security Policy ---');
  console.log('DeckAgent will only access directories you allow (not your full home folder by default).\n');

  const allowed = getDefaultAllowedDirectories();
  console.log(`Default allowed directories:\n  ${allowed.map((d) => `- ${d}`).join('\n')}`);

  const addMore = await askYesNo('Add more allowed directories?', false);
  if (addMore) {
    const extra = await askQuestion(
      'Enter additional directories (comma-separated, ~ expanded): '
    );
    if (extra) {
      for (const part of extra.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const expanded = trimmed.startsWith('~')
          ? path.join(os.homedir(), trimmed.slice(1).replace(/^\//, ''))
          : path.resolve(trimmed);
        if (!allowed.includes(expanded)) {
          allowed.push(expanded);
        }
      }
    }
  }

  // Confirmation stays ON by default for mutating tools.
  const keepConfirmation = await askYesNo(
    'Require confirmation for mutating tools (write/edit/move/execute/kill)?',
    true
  );

  const readOnly = await askYesNo(
    'Start in read-only mode? (recommended for first run)',
    true
  );

  let allowTerminal = true;
  if (readOnly) {
    const narrowTerminal = await askYesNo(
      'Also disable terminal tools while in read-only mode? (narrower surface)',
      false
    );
    allowTerminal = !narrowTerminal;
    if (!narrowTerminal) {
      console.log('Terminal stays enabled; read_only still blocks mutating filesystem tools.');
    }
  }

  const policy = generateDefaultPolicy({
    allowed_directories: allowed,
    require_confirmation: keepConfirmation ? [...DEFAULT_REQUIRE_CONFIRMATION] : [],
    read_only: readOnly,
    allow_terminal: allowTerminal
  });

  printSecuritySummary(policy);
  return policy;
}
