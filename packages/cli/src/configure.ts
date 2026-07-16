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

export const PolicySchema = z.object({
  version: z.number().int().default(1),
  allowed_directories: z.array(z.string()).default([]),
  blocked_commands: z.array(z.string()).default([
    'rm -rf',
    'sudo',
    'shutdown',
    'reboot',
    'poweroff',
    'init',
    'dd',
    'mkfs'
  ]),
  require_confirmation: z.array(z.string()).default([
    'execute_command',
    'write_file',
    'edit_file',
    'move_file',
    'kill_process'
  ]),
  read_only: z.boolean().default(false),
  // true: setup registers browser capabilities; daemon schema defaults false until policy is written
  allow_browser: z.boolean().default(true),
  allow_terminal: z.boolean().default(true),
  allow_computer_use: z.boolean().default(false),
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

export function generateDefaultPolicy(): Policy {
  const home = os.homedir();
  // Aligned with daemon PolicySchema: confirmation for mutating/dangerous tools.
  // allow_browser defaults to true here because setup registers browser capabilities.
  return {
    version: 1,
    allowed_directories: [home],
    blocked_commands: ['rm -rf', 'sudo', 'shutdown', 'reboot', 'poweroff', 'init', 'dd', 'mkfs'],
    require_confirmation: ['execute_command', 'write_file', 'edit_file', 'move_file', 'kill_process'],
    read_only: false,
    allow_browser: true,
    allow_terminal: true,
    allow_computer_use: false,
    max_file_read_size: 10 * 1024 * 1024,
    max_command_timeout: 300
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

export function askYesNo(query: string): Promise<boolean> {
  return askQuestion(`${query} (y/N): `).then((answer) => {
    const normalized = answer.toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  });
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
