import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { z } from 'zod';
import { ConfigSchema, getConfigDir, getConfigPath, getPolicyPath } from './configure.js';

export interface Check {
  label: string;
  ok: boolean;
  value?: string;
  message?: string;
}

export interface DoctorPaths {
  configPath: string;
  policyPath: string;
  pidPath: string;
  healthPath: string;
}

type HealthTunnelState = 'connected' | 'connecting' | 'disconnected';

const HealthFileSchema = z.object({
  ok: z.boolean(),
  pid: z.number().int(),
  device_id: z.string().min(1),
  tunnel: z.enum(['connected', 'connecting', 'disconnected']),
  last_heartbeat_at: z.string().datetime(),
  worker_url: z.string().url(),
  version: z.string().min(1)
});

export type HealthFile = z.infer<typeof HealthFileSchema>;

export type HealthReadResult =
  | { status: 'missing'; path: string; message: string }
  | { status: 'invalid'; path: string; message: string }
  | {
      status: 'present';
      path: string;
      health: HealthFile;
      ageSeconds: number;
      stale: boolean;
      staleAfterSeconds: number;
      message: string;
    };

export interface DoctorReport {
  checks: Check[];
  failed: Check[];
  ok: boolean;
  paths: DoctorPaths;
  health: HealthReadResult;
}

export interface DoctorCollectOptions {
  baseDir?: string;
  intervalSeconds?: number;
  now?: () => number;
}

export interface DoctorWatchOptions extends DoctorCollectOptions {
  failAfterSeconds?: number;
  output?: Pick<typeof console, 'log' | 'error'>;
  sleep?: (ms: number) => Promise<void>;
  exitOnSigint?: boolean;
}

interface ParsedDoctorArgs {
  watch: boolean;
  intervalSeconds: number;
  failAfterSeconds: number;
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

function getDoctorPaths(baseDir = getConfigDir()): DoctorPaths {
  if (baseDir === getConfigDir()) {
    return {
      configPath: getConfigPath(),
      policyPath: getPolicyPath(),
      pidPath: path.join(baseDir, 'daemon.pid'),
      healthPath: path.join(baseDir, 'health.json')
    };
  }
  return {
    configPath: path.join(baseDir, 'config.json'),
    policyPath: path.join(baseDir, 'policy.json'),
    pidPath: path.join(baseDir, 'daemon.pid'),
    healthPath: path.join(baseDir, 'health.json')
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidFile: string): number | null {
  if (!fs.existsSync(pidFile)) {
    return null;
  }
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isDaemonRunning(pidFile: string): boolean {
  const pid = readPid(pidFile);
  return pid !== null && isProcessAlive(pid);
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const field = issue.path.join('.') || 'value';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

function readHealthFile(
  healthPath: string,
  nowMs: number,
  staleAfterSeconds: number
): HealthReadResult {
  if (!fs.existsSync(healthPath)) {
    return {
      status: 'missing',
      path: healthPath,
      message: `not found: ${healthPath}`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
  } catch (err) {
    return {
      status: 'invalid',
      path: healthPath,
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const result = HealthFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: 'invalid',
      path: healthPath,
      message: `invalid health.json: ${formatZodError(result.error)}`
    };
  }

  const heartbeatMs = Date.parse(result.data.last_heartbeat_at);
  const ageSeconds = Math.max(0, (nowMs - heartbeatMs) / 1000);
  const stale = ageSeconds > staleAfterSeconds;
  const statusText = [
    `tunnel=${result.data.tunnel}`,
    `ok=${String(result.data.ok)}`,
    `heartbeat=${ageSeconds.toFixed(1)}s ago`,
    `pid=${result.data.pid}`
  ].join(', ');

  return {
    status: 'present',
    path: healthPath,
    health: result.data,
    ageSeconds,
    stale,
    staleAfterSeconds,
    message: stale ? `${statusText}, stale>${staleAfterSeconds}s` : statusText
  };
}

function healthCheckOk(health: HealthReadResult, daemonRunning: boolean): boolean {
  if (health.status === 'missing') {
    return !daemonRunning;
  }
  if (health.status === 'invalid') {
    return false;
  }
  return health.health.ok && health.health.tunnel === 'connected' && !health.stale;
}

function healthCheckMessage(health: HealthReadResult, daemonRunning: boolean): string {
  if (health.status === 'missing' && !daemonRunning) {
    return 'not present (daemon not running)';
  }
  return health.message;
}

export async function collectDoctorResults(options: DoctorCollectOptions = {}): Promise<DoctorReport> {
  const intervalSeconds = options.intervalSeconds ?? 5;
  const staleAfterSeconds = Math.max(2 * intervalSeconds, 45);
  const nowMs = options.now?.() ?? Date.now();
  const paths = getDoctorPaths(options.baseDir);

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
  let configOk = false;
  let configMessage = 'not found';
  let apiToken: string | null = null;
  if (fs.existsSync(paths.configPath)) {
    try {
      const raw = fs.readFileSync(paths.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      configOk = true;
      configMessage = paths.configPath;
      const parsedConfig = ConfigSchema.safeParse(parsed);
      apiToken = parsedConfig.success ? parsedConfig.data.api_token : null;
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
  let policyOk = false;
  let policyMessage = 'not found';
  if (fs.existsSync(paths.policyPath)) {
    try {
      const raw = fs.readFileSync(paths.policyPath, 'utf-8');
      JSON.parse(raw);
      policyOk = true;
      policyMessage = paths.policyPath;
    } catch (err) {
      policyOk = false;
      policyMessage = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  checks.push({ label: 'policy.json', ok: policyOk, message: policyMessage });

  // daemon running
  const daemonRunning = isDaemonRunning(paths.pidPath);
  checks.push({ label: 'daemon running', ok: daemonRunning, message: daemonRunning ? 'PID file active' : 'not running' });

  // daemon health.json
  const health = readHealthFile(paths.healthPath, nowMs, staleAfterSeconds);
  checks.push({
    label: 'daemon health',
    ok: healthCheckOk(health, daemonRunning),
    message: healthCheckMessage(health, daemonRunning)
  });

  // OS info
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  checks.push({ label: 'platform', ok: true, value: `${platform} ${release} (${arch})` });

  const failed = checks.filter((c) => !c.ok);
  return {
    checks,
    failed,
    ok: failed.length === 0,
    paths,
    health
  };
}

function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const readSeconds = (flag: string, fallback: number): number => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const raw = args[index + 1];
    if (!raw || raw.startsWith('--')) {
      throw new Error(`${flag} requires a positive number of seconds`);
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${flag} must be a positive number of seconds`);
    }
    return parsed;
  };

  return {
    watch: args.includes('--watch'),
    intervalSeconds: readSeconds('--interval', 5),
    failAfterSeconds: readSeconds('--fail-after', 30)
  };
}

function printDoctorHelp(): void {
  console.log(`Usage: deckagent doctor [--watch] [--interval <sec>] [--fail-after <sec>]

Options:
  --watch              Continuously check DeckAgent health
  --interval <sec>     Seconds between checks in watch mode (default 5)
  --fail-after <sec>   Exit 1 after this many unhealthy seconds (default 30)
`);
}

function printOneShotReport(report: DoctorReport): void {
  console.log('\n🩺 DeckAgent Doctor\n');
  console.log('Checking your DeckAgent environment...\n');

  // Find longest label for alignment
  const maxLabel = Math.max(...report.checks.map((c) => c.label.length));

  for (const check of report.checks) {
    const icon = check.ok ? greenCheck() : redCross();
    const label = check.label.padEnd(maxLabel);
    const detail = check.value ?? check.message ?? '';
    console.log(`${icon}  ${label}  ${detail}`);
  }

  console.log('');
  if (report.failed.length === 0) {
    console.log('All checks passed. DeckAgent looks healthy!\n');
  } else {
    console.log(`${report.failed.length} check(s) failed. See details above.\n`);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeHealthForWatch(health: HealthReadResult): { tunnel: HealthTunnelState | 'unknown'; heartbeat: string } {
  if (health.status !== 'present') {
    return { tunnel: 'unknown', heartbeat: health.status };
  }
  return {
    tunnel: health.health.tunnel,
    heartbeat: `${health.ageSeconds.toFixed(1)}s${health.stale ? ' stale' : ''}`
  };
}

function formatWatchLine(report: DoctorReport, nowMs: number): string {
  const health = describeHealthForWatch(report.health);
  const failedLabels = report.failed.map((check) => check.label).join(',');
  const failedPart = failedLabels.length > 0 ? ` failed=${failedLabels}` : '';
  return [
    new Date(nowMs).toISOString(),
    report.ok ? 'ok' : 'unhealthy',
    `checks=${report.checks.length - report.failed.length}/${report.checks.length}`,
    `tunnel=${health.tunnel}`,
    `heartbeat=${health.heartbeat}${failedPart}`
  ].join(' ');
}

export async function runDoctorWatch(options: DoctorWatchOptions = {}): Promise<number> {
  const intervalSeconds = options.intervalSeconds ?? 5;
  const failAfterSeconds = options.failAfterSeconds ?? 30;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('--interval must be a positive number of seconds');
  }
  if (!Number.isFinite(failAfterSeconds) || failAfterSeconds <= 0) {
    throw new Error('--fail-after must be a positive number of seconds');
  }

  const output = options.output ?? console;
  const sleep = options.sleep ?? defaultSleep;
  const intervalMs = intervalSeconds * 1000;
  const failAfterMs = failAfterSeconds * 1000;
  let unhealthySince: number | null = null;

  const sigintHandler = (): void => {
    process.exit(130);
  };
  if (options.exitOnSigint !== false) {
    process.once('SIGINT', sigintHandler);
  }

  try {
    while (true) {
      const nowMs = options.now?.() ?? Date.now();
      const report = await collectDoctorResults({
        baseDir: options.baseDir,
        intervalSeconds,
        now: () => nowMs
      });

      output.log(formatWatchLine(report, nowMs));

      if (report.ok) {
        unhealthySince = null;
      } else {
        unhealthySince ??= nowMs;
        if (nowMs - unhealthySince >= failAfterMs) {
          output.error(`DeckAgent doctor unhealthy for ${failAfterSeconds}s; exiting 1.`);
          return 1;
        }
      }

      await sleep(intervalMs);
    }
  } finally {
    if (options.exitOnSigint !== false) {
      process.off('SIGINT', sigintHandler);
    }
  }
}

export async function runDoctor(args: string[] = []): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printDoctorHelp();
    return 0;
  }

  let parsed: ParsedDoctorArgs;
  try {
    parsed = parseDoctorArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printDoctorHelp();
    return 1;
  }

  if (parsed.watch) {
    return runDoctorWatch({
      intervalSeconds: parsed.intervalSeconds,
      failAfterSeconds: parsed.failAfterSeconds
    });
  }

  const report = await collectDoctorResults({
    intervalSeconds: parsed.intervalSeconds
  });
  printOneShotReport(report);
  return 0;
}
