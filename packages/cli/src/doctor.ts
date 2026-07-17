import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getConfigPath, getPolicyPath, configExists, readConfig } from './configure.js';

interface Check {
  label: string;
  ok: boolean;
  value?: string;
  message?: string;
}

function greenCheck(): string {
  return '✅';
}

function redCross(): string {
  return '❌';
}

function runCommand(cmd: string, timeout = 5000): string | null {
  try {
    const result = execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim();
  } catch {
    return null;
  }
}

function commandExists(cmd: string): boolean {
  const platform = os.platform();
  const checkCmd = platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
  return runCommand(checkCmd) !== null;
}

function isDaemonRunning(): boolean {
  const pidFile = path.join(os.homedir(), '.deckagent', 'daemon.pid');
  if (!fs.existsSync(pidFile)) {
    return false;
  }
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (Number.isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<void> {
  console.log('\n🩺 DeckAgent Doctor\n');
  console.log('Checking your DeckAgent environment...\n');

  const checks: Check[] = [];

  // Node.js version
  const nodeVersion = process.version;
  checks.push({ label: 'Node.js', ok: true, value: nodeVersion });

  // npm version
  const npmVersion = runCommand('npm --version');
  checks.push({ label: 'npm', ok: npmVersion !== null, value: npmVersion ?? 'not found' });

  // wrangler installed
  const wranglerInstalled = commandExists('wrangler');
  checks.push({ label: 'wrangler installed', ok: wranglerInstalled, message: wranglerInstalled ? 'found' : 'not found in PATH' });

  // config.json
  const configPath = getConfigPath();
  let configOk = false;
  let configMessage = 'not found';
  let apiToken: string | null = null;
  if (configExists()) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      JSON.parse(raw);
      configOk = true;
      configMessage = configPath;
      try {
        apiToken = readConfig().api_token;
      } catch {
        apiToken = null;
      }
    } catch (err) {
      configOk = false;
      configMessage = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  checks.push({ label: 'config.json', ok: configOk, message: configMessage });

  // api_token field
  checks.push({
    label: 'api_token configured',
    ok: configOk && !!apiToken,
    message: apiToken ? 'present' : 'missing from config.json'
  });

  // policy.json
  const policyPath = getPolicyPath();
  let policyOk = false;
  let policyMessage = 'not found';
  if (fs.existsSync(policyPath)) {
    try {
      const raw = fs.readFileSync(policyPath, 'utf-8');
      JSON.parse(raw);
      policyOk = true;
      policyMessage = policyPath;
    } catch (err) {
      policyOk = false;
      policyMessage = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  checks.push({ label: 'policy.json', ok: policyOk, message: policyMessage });

  // daemon running
  const daemonRunning = isDaemonRunning();
  checks.push({ label: 'daemon running', ok: daemonRunning, message: daemonRunning ? `PID file active` : 'not running' });

  // OS info
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  checks.push({ label: 'platform', ok: true, value: `${platform} ${release} (${arch})` });

  // Find longest label for alignment
  const maxLabel = Math.max(...checks.map((c) => c.label.length));

  for (const check of checks) {
    const icon = check.ok ? greenCheck() : redCross();
    const label = check.label.padEnd(maxLabel);
    const detail = check.value ?? check.message ?? '';
    console.log(`${icon}  ${label}  ${detail}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('All checks passed. DeckAgent looks healthy!\n');
  } else {
    console.log(`${failed.length} check(s) failed. See details above.\n`);
  }
}
