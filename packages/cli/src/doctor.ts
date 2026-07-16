import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { z } from 'zod';
import { ConfigSchema, getConfigDir, getConfigPath, getPolicyPath } from './configure.js';
import { commandLine, sectionTitle, statusText, supportsColor, type Output } from './ux.js';

export interface Check {
  label: string;
  ok: boolean;
  value?: string;
  message?: string;
  remediation?: string;
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
  version: z.string().min(1),
  connected_at: z.string().datetime().nullable().optional(),
  last_disconnect_at: z.string().datetime().nullable().optional(),
  last_disconnect_reason: z.string().nullable().optional(),
  reconnect_attempt: z.number().int().nonnegative().optional(),
  next_reconnect_at: z.string().datetime().nullable().optional(),
  worker_version: z.string().min(1).optional(),
  protocol_warning: z.string().min(1).optional()
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
  output?: Output;
  sleep?: (ms: number) => Promise<void>;
  exitOnSigint?: boolean;
}

export interface DoctorCommandOptions extends DoctorCollectOptions {
  output?: Output;
}

interface ParsedDoctorArgs {
  watch: boolean;
  json: boolean;
  strict: boolean;
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
    `pid=${result.data.pid}`,
    ...(result.data.reconnect_attempt
      ? [`reconnect_attempt=${result.data.reconnect_attempt}`]
      : []),
    ...(result.data.next_reconnect_at
      ? [`next_reconnect_at=${result.data.next_reconnect_at}`]
      : []),
    ...(result.data.last_disconnect_reason
      ? [`last_disconnect=${result.data.last_disconnect_reason}`]
      : [])
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

function compatibilityCheck(health: HealthReadResult): Check {
  if (health.status !== 'present') {
    return {
      label: 'Worker compatibility',
      ok: false,
      message: `unknown (${health.status} health.json)`
    };
  }

  const workerVersion = health.health.worker_version ?? 'unknown';
  const warning = health.health.protocol_warning;
  return {
    label: 'Worker compatibility',
    ok: !warning,
    message: warning
      ? `worker=${workerVersion}, warning=${warning}`
      : `worker=${workerVersion}, protocol ok`
  };
}

function remediationForCheck(check: Check): string {
  switch (check.label) {
    case 'npm':
      return 'Install npm with Node.js 18+ and rerun deckagent doctor.';
    case 'wrangler installed':
      return 'Install Wrangler with `npm install -g wrangler` or rerun `deckagent setup`.';
    case 'config.json':
      return 'Create config with `deckagent setup`, or repair ~/.deckagent/config.json.';
    case 'api_token configured':
      return 'Run `deckagent token rotate --deploy`, or add api_token to ~/.deckagent/config.json.';
    case 'policy.json':
      return 'Create policy with `deckagent policy set-profile strict` or rerun `deckagent setup`.';
    case 'daemon running':
      return 'Start the daemon with `deckagent daemon` or debug in foreground with `deckagent daemon --foreground`.';
    case 'daemon health':
      return 'Run `deckagent daemon --foreground` and inspect `deckagent logs` for tunnel or health write errors.';
    case 'Worker compatibility':
      return 'Redeploy the Worker or upgrade the daemon so their protocol versions match.';
    default:
      return 'Run `deckagent doctor --json` for machine-readable details, then retry after fixing the failed check.';
  }
}

function addRemediation(check: Check): Check {
  if (check.ok) {
    return check;
  }
  return { ...check, remediation: remediationForCheck(check) };
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
  checks.push(compatibilityCheck(health));

  // OS info
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  checks.push({ label: 'platform', ok: true, value: `${platform} ${release} (${arch})` });

  const checksWithRemediation = checks.map(addRemediation);
  const failed = checksWithRemediation.filter((c) => !c.ok);
  return {
    checks: checksWithRemediation,
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
    json: args.includes('--json'),
    strict: args.includes('--strict'),
    intervalSeconds: readSeconds('--interval', 5),
    failAfterSeconds: readSeconds('--fail-after', 30)
  };
}

function printDoctorHelp(output: Output = console): void {
  output.log(`Usage: deckagent doctor [--json] [--strict] [--watch] [--interval <sec>] [--fail-after <sec>]

Options:
  --json              Print a machine-readable report with a checks array
  --strict            In one-shot mode, exit 1 when any check fails
  --watch              Continuously check DeckAgent health
  --interval <sec>     Seconds between checks in watch mode (default 5)
  --fail-after <sec>   Exit 1 after this many unhealthy seconds (default 30)
`);
}

function printOneShotReport(report: DoctorReport, output: Output = console): void {
  const colorEnabled = supportsColor(output);
  output.log('');
  output.log(sectionTitle('DeckAgent Doctor', colorEnabled));
  output.log('');
  output.log('Checking your DeckAgent environment...');
  output.log('');

  // Find longest label for alignment
  const maxLabel = Math.max(...report.checks.map((c) => c.label.length));

  for (const check of report.checks) {
    const icon = check.ok ? greenCheck() : redCross();
    const status = statusText(check.ok ? 'pass' : 'fail', colorEnabled);
    const label = check.label.padEnd(maxLabel);
    const detail = check.value ?? check.message ?? '';
    output.log(`${icon}  ${status}  ${label}  ${detail}`);
    if (!check.ok && check.remediation) {
      output.log(`      Fix: ${check.remediation}`);
    }
  }

  output.log('');
  if (report.failed.length === 0) {
    output.log('All checks passed. DeckAgent looks healthy!');
  } else {
    output.log(`${report.failed.length} check(s) failed. See Fix lines above.`);
    output.log(`Next command: ${commandLine('deckagent doctor --json', colorEnabled)}`);
  }
  output.log('');
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

export async function runDoctor(args: string[] = [], options: DoctorCommandOptions = {}): Promise<number> {
  const output = options.output ?? console;
  if (args.includes('--help') || args.includes('-h')) {
    printDoctorHelp(output);
    return 0;
  }

  let parsed: ParsedDoctorArgs;
  try {
    parsed = parseDoctorArgs(args);
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    printDoctorHelp(output);
    return 1;
  }

  if (parsed.watch) {
    if (parsed.json) {
      output.error('--json cannot be combined with --watch.');
      printDoctorHelp(output);
      return 1;
    }
    return runDoctorWatch({
      baseDir: options.baseDir,
      intervalSeconds: parsed.intervalSeconds,
      failAfterSeconds: parsed.failAfterSeconds,
      now: options.now,
      output
    });
  }

  const report = await collectDoctorResults({
    baseDir: options.baseDir,
    intervalSeconds: parsed.intervalSeconds,
    now: options.now
  });
  if (parsed.json) {
    output.log(JSON.stringify(report, null, 2));
  } else {
    printOneShotReport(report, output);
  }
  return parsed.strict && !report.ok ? 1 : 0;
}
