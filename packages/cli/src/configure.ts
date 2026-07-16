import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { z } from 'zod';

export const WorkspaceSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1),
  allow_outside_with_confirmation: z.boolean().default(true)
});

export const ConfigSchema = z.object({
  device_id: z.string().uuid(),
  token: z.string().min(32),
  worker_url: z.string().url(),
  device_name: z.string().min(1),
  api_token: z.string().min(32),
  heartbeat_interval: z.number().int().default(15),
  tool_timeout: z.number().int().default(60),
  auto_connect: z.boolean().default(true),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  preferred_device_id: z.string().uuid().optional(),
  // Optional project scope (Wave 3 F1). Must be preserved on read/write.
  workspace: WorkspaceSchema.optional()
});

export const DEFAULT_REQUIRE_CONFIRMATION = [
  'execute_command',
  'write_file',
  'edit_file',
  'move_file',
  'kill_process',
  'restore_snapshot'
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

/** Wave 3 F6 — rate limits & budgets (defaults from WAVE3_FEATURE_SPEC). */
export const DEFAULT_BUDGETS = {
  max_tool_calls_per_hour: 300,
  max_shell_seconds_per_hour: 600,
  max_bytes_written_per_hour: 50_000_000,
  max_confirmations_per_hour: 60
} as const;

/** Wave 4 S1 — strict profile allowlist. */
export const DEFAULT_STRICT_ALLOWED_COMMANDS = [
  'git',
  'npm',
  'node',
  'python',
  'pytest',
  'cargo',
  'go',
  'make'
] as const;

export const DEFAULT_PROTECTED_PATHS = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/gcloud',
  '**/.env',
  '**/.env.*',
  '**/credentials.json',
  '**/id_rsa',
  '**/id_ed25519'
] as const;

export const BudgetsSchema = z.object({
  max_tool_calls_per_hour: z.number().int().default(DEFAULT_BUDGETS.max_tool_calls_per_hour),
  max_shell_seconds_per_hour: z
    .number()
    .int()
    .default(DEFAULT_BUDGETS.max_shell_seconds_per_hour),
  max_bytes_written_per_hour: z
    .number()
    .int()
    .default(DEFAULT_BUDGETS.max_bytes_written_per_hour),
  max_confirmations_per_hour: z
    .number()
    .int()
    .default(DEFAULT_BUDGETS.max_confirmations_per_hour)
});

export const PathRulesSchema = z.object({
  symlink_mode: z.enum(['deny_escape', 'deny_symlinks', 'follow']).default('deny_escape'),
  allow_dotdot: z.boolean().default(false)
});

export const NetworkSchema = z.object({
  allow_browser_hosts: z.array(z.string()).default([]),
  deny_browser_hosts: z.array(z.string()).default([]),
  block_shell_net_tools: z.boolean().default(false)
});

export const PolicySchema = z
  .object({
    version: z.number().int().default(2),
    profile: z.enum(['strict', 'dev', 'locked']).default('strict'),
    profile_locked: z.boolean().default(false),
    allowed_directories: z.array(z.string()).default([]),
    trusted_directories: z.array(z.string()).default([]),
    denied_directories: z.array(z.string()).default([]),
    protected_paths: z.array(z.string()).default([...DEFAULT_PROTECTED_PATHS]),
    protected_path_policy: z.enum(['deny_all', 'deny_write']).default('deny_all'),
    path_rules: PathRulesSchema.default({
      symlink_mode: 'deny_escape',
      allow_dotdot: false
    }),
    trusted_read_directories: z.array(z.string()).default([]),
    trusted_write_directories: z.array(z.string()).default([]),
    blocked_commands: z.array(z.string()).default([...DEFAULT_BLOCKED_COMMANDS]),
    require_confirmation: z.array(z.string()).default([...DEFAULT_REQUIRE_CONFIRMATION]),
    read_only: z.boolean().default(false),
    read_only_mode: z.enum(['fs_read', 'meta_only']).default('fs_read'),
    // true: setup registers browser capabilities; daemon schema defaults false until policy is written
    allow_browser: z.boolean().default(true),
    allow_terminal: z.boolean().default(true),
    allow_computer_use: z.boolean().default(false),
    command_mode: z.enum(['blocklist', 'allowlist']).default('blocklist'),
    allowed_commands: z.array(z.string()).default([]),
    terminal_mode: z.enum(['off', 'allowlist', 'blocklist', 'sandbox_fs']).default('blocklist'),
    network: NetworkSchema.default({
      allow_browser_hosts: [],
      deny_browser_hosts: [],
      block_shell_net_tools: false
    }),
    max_file_read_size: z.number().int().default(10 * 1024 * 1024),
    max_command_timeout: z.number().int().default(300),
    // Wave 3 F4 — vault injection into execute_command env
    allow_secret_injection: z.boolean().default(true),
    // Wave 3 F6
    budgets: BudgetsSchema.default({ ...DEFAULT_BUDGETS }),
    disable_builtin_protections: z.boolean().default(false)
  })
  .passthrough();

export type Config = z.infer<typeof ConfigSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type SecurityProfile = Policy['profile'];

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
 * Safer defaults for strangers: ~/DeckAgent (created if missing).
 * Never defaults to full $HOME.
 */
export function getDefaultTrustedDirectory(): string {
  const deckAgentDir = path.join(os.homedir(), 'DeckAgent');
  fs.mkdirSync(deckAgentDir, { recursive: true });
  return deckAgentDir;
}

/**
 * @deprecated Prefer getDefaultTrustedDirectory — kept for workspace helpers.
 */
export function getDefaultAllowedDirectories(): string[] {
  return [getDefaultTrustedDirectory()];
}

/** Profile-specific hard defaults (does not silently widen overrides). */
export function applyProfileDefaults(
  profile: SecurityProfile,
  base: Partial<Policy> = {}
): Partial<Policy> {
  if (profile === 'strict' || profile === 'locked') {
    const allowTerminal = base.allow_terminal ?? false;
    return {
      ...base,
      profile,
      profile_locked: profile === 'locked',
      version: 2,
      command_mode: 'allowlist',
      terminal_mode: allowTerminal ? 'allowlist' : 'off',
      allowed_commands: [...DEFAULT_STRICT_ALLOWED_COMMANDS],
      allow_browser: false,
      allow_secret_injection: false,
      allow_terminal: allowTerminal,
      protected_path_policy: 'deny_all',
      network: {
        allow_browser_hosts: [],
        deny_browser_hosts: ['*'],
        block_shell_net_tools: true
      },
      path_rules: {
        symlink_mode: 'deny_escape',
        allow_dotdot: false
      },
      protected_paths:
        base.protected_paths && base.protected_paths.length > 0
          ? base.protected_paths
          : [...DEFAULT_PROTECTED_PATHS]
    };
  }

  // dev
  return {
    ...base,
    profile: 'dev',
    profile_locked: false,
    version: 2,
    command_mode: base.command_mode ?? 'blocklist',
    terminal_mode: base.terminal_mode ?? (base.allow_terminal === false ? 'off' : 'blocklist'),
    allow_browser: base.allow_browser ?? true,
    allow_terminal: base.allow_terminal ?? true,
    allow_secret_injection: base.allow_secret_injection ?? true,
    protected_path_policy: base.protected_path_policy ?? 'deny_write',
    network: base.network ?? {
      allow_browser_hosts: [],
      deny_browser_hosts: [],
      block_shell_net_tools: false
    },
    path_rules: base.path_rules ?? {
      symlink_mode: 'deny_escape',
      allow_dotdot: false
    }
  };
}

export function generateDefaultPolicy(overrides: Partial<Policy> = {}): Policy {
  const profile = overrides.profile ?? 'strict';
  const trusted =
    overrides.trusted_directories && overrides.trusted_directories.length > 0
      ? overrides.trusted_directories
      : overrides.allowed_directories && overrides.allowed_directories.length > 0
        ? overrides.allowed_directories
        : [getDefaultTrustedDirectory()];

  const profileDefaults = applyProfileDefaults(profile, {
    trusted_directories: trusted,
    allowed_directories: trusted,
    ...overrides
  });

  return PolicySchema.parse({
    blocked_commands: [...DEFAULT_BLOCKED_COMMANDS],
    require_confirmation: [...DEFAULT_REQUIRE_CONFIRMATION],
    read_only: false,
    allow_computer_use: false,
    max_file_read_size: 10 * 1024 * 1024,
    max_command_timeout: 300,
    budgets: { ...DEFAULT_BUDGETS },
    denied_directories: [],
    trusted_read_directories: [],
    trusted_write_directories: [],
    disable_builtin_protections: false,
    ...profileDefaults
  });
}

function writeSecureJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on some Windows setups; mode on create is best-effort there.
  }
}

export function writeConfig(config: Config): void {
  ensureConfigDir();
  // Parse through schema so optional workspace is preserved (or stripped when cleared).
  writeSecureJson(getConfigPath(), ConfigSchema.parse(config));
}

export function writePolicy(policy: Policy): void {
  ensureConfigDir();
  writeSecureJson(getPolicyPath(), PolicySchema.parse(policy));
}

export function writeConfigFiles(config: Config, policy: Policy): void {
  writeConfig(config);
  writePolicy(policy);
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

export function policyExists(): boolean {
  return fs.existsSync(getPolicyPath());
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
  const trusted =
    policy.trusted_directories.length > 0
      ? policy.trusted_directories
      : policy.allowed_directories;
  console.log('--- Security summary ---');
  console.log(`  Profile:            ${policy.profile}${policy.profile_locked ? ' (LOCKED)' : ''}`);
  console.log(`  Trusted directories: ${trusted.join(', ') || '(none)'}`);
  if (policy.denied_directories.length > 0) {
    console.log(`  Denied directories:  ${policy.denied_directories.join(', ')}`);
  }
  console.log(`  Read-only mode:     ${policy.read_only ? 'ON' : 'OFF'}`);
  console.log(`  Terminal tools:     ${policy.allow_terminal ? 'allowed' : 'disabled'} (${policy.terminal_mode})`);
  console.log(`  Browser tools:      ${policy.allow_browser ? 'allowed' : 'disabled'}`);
  console.log(
    `  Confirm mutations:  ${
      policy.require_confirmation.length > 0
        ? `ON (${policy.require_confirmation.join(', ')})`
        : 'OFF'
    }`
  );
  console.log(`  Command mode:       ${policy.command_mode}`);
  if (policy.command_mode === 'allowlist') {
    console.log(`  Allowed commands:   ${policy.allowed_commands.join(', ') || '(none)'}`);
  } else {
    console.log(`  Blocked commands:   ${policy.blocked_commands.join(', ')}`);
  }
  console.log(`  Policy file:        ${getPolicyPath()} (mode 0600)`);
  console.log('');
}

/**
 * Interactive first-run policy prompts. Defaults to strict profile + ~/DeckAgent.
 */
export async function promptForPolicy(): Promise<Policy> {
  console.log('\n--- Security Policy ---');
  console.log('DeckAgent enforces access in the local daemon (not via prompts to the model).\n');

  const profileAnswer = await askQuestion('Security profile? [strict/dev] (default strict): ');
  const normalized = profileAnswer.toLowerCase();
  const profile: SecurityProfile =
    normalized === 'dev' ? 'dev' : normalized === 'locked' ? 'locked' : 'strict';

  const defaultTrusted = getDefaultTrustedDirectory();
  const trustedAnswer = await askQuestion(
    `Trusted project directory? (default ${defaultTrusted}): `
  );
  let trustedPath = defaultTrusted;
  if (trustedAnswer) {
    trustedPath = trustedAnswer.startsWith('~')
      ? path.join(os.homedir(), trustedAnswer.slice(1).replace(/^\//, ''))
      : path.resolve(trustedAnswer);
  }
  fs.mkdirSync(trustedPath, { recursive: true });

  const allowTerminal =
    profile === 'strict' || profile === 'locked'
      ? await askYesNo('Enable terminal tools? (strict uses an allowlist)', false)
      : await askYesNo('Enable terminal tools?', true);

  const allowBrowser =
    profile === 'dev'
      ? await askYesNo('Enable browser tools?', false)
      : false;

  const keepConfirmation = await askYesNo(
    'Require confirmation for mutating tools (write/edit/move/execute/kill)?',
    true
  );

  const policy = generateDefaultPolicy({
    profile,
    trusted_directories: [trustedPath],
    allowed_directories: [trustedPath],
    allow_terminal: allowTerminal,
    allow_browser: allowBrowser,
    require_confirmation: keepConfirmation ? [...DEFAULT_REQUIRE_CONFIRMATION] : [],
    terminal_mode: allowTerminal
      ? profile === 'dev'
        ? 'blocklist'
        : 'allowlist'
      : 'off'
  });

  printSecuritySummary(policy);
  return policy;
}
