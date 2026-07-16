import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ConfigSchema,
  PolicySchema,
  getConfigDir,
  getConfigPath,
  getPolicyPath,
  type Config,
  type Policy
} from './configure.js';
import { runSmokeMatrix, type SmokeReport } from './smoke.js';

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<Response>;

type Output = Pick<typeof console, 'log' | 'error'>;

const HealthFileSchema = z.object({
  ok: z.boolean(),
  pid: z.number().int(),
  device_id: z.string().min(1),
  tunnel: z.enum(['connected', 'connecting', 'disconnected']),
  last_heartbeat_at: z.string().datetime(),
  worker_url: z.string().url(),
  version: z.string().min(1)
}).passthrough();

const JsonRpcInitializeResponseSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z
    .object({
      protocolVersion: z.string().optional(),
      serverInfo: z
        .object({
          name: z.string().optional(),
          version: z.string().optional()
        })
        .passthrough()
        .optional()
    })
    .passthrough()
    .optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.record(z.unknown()).optional()
    })
    .optional()
});

export interface OnboardCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail?: string;
}

export interface OnboardNextActions {
  ui: string;
  connector_url?: string;
  workspace: string;
}

export interface OnboardReport {
  ok: boolean;
  checks: OnboardCheck[];
  failed: OnboardCheck[];
  warnings: OnboardCheck[];
  paths: {
    configPath: string;
    policyPath: string;
    pidPath: string;
    healthPath: string;
  };
  next_actions: OnboardNextActions;
  smoke?: SmokeReport;
}

export interface OnboardCollectOptions {
  fetch?: FetchLike;
  baseDir?: string;
  now?: () => number;
  skipSmoke?: boolean;
}

export interface OnboardCommandOptions extends OnboardCollectOptions {
  output?: Output;
}

interface ParsedOnboardArgs {
  help: boolean;
  json: boolean;
  skipSmoke: boolean;
}

function getFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch !== 'function') {
    throw new Error('This command requires Node.js fetch support. Use Node 18 or newer.');
  }
  return fetch;
}

function pathsForBaseDir(baseDir = getConfigDir()): OnboardReport['paths'] {
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

function check(
  id: string,
  label: string,
  status: OnboardCheck['status'],
  detail?: string
): OnboardCheck {
  return detail ? { id, label, status, detail } : { id, label, status };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJsonFile<T>(filePath: string, schema: { parse: (value: unknown) => T }): T {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return schema.parse(JSON.parse(raw));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidPath: string): number | null {
  if (!fs.existsSync(pidPath)) {
    return null;
  }
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function trustedDirectoryCount(policy: Policy): number {
  return policy.trusted_directories.filter((dir) => dir.trim().length > 0).length;
}

function selectListDirectoryPolicy(policy: Policy | null): Policy | null {
  return policy;
}

function mcpUrl(workerUrl: string): string {
  const trimmed = workerUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
}

function healthUrl(workerUrl: string): string {
  return String(new URL('/health', workerUrl));
}

async function checkWorkerHealth(fetchImpl: FetchLike, config: Config): Promise<OnboardCheck> {
  const url = healthUrl(config.worker_url);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    return check(
      'worker_health',
      'Worker /health',
      response.status === 200 ? 'pass' : 'fail',
      response.status === 200 ? url : `${url} returned HTTP ${response.status}`
    );
  } catch (err) {
    return check('worker_health', 'Worker /health', 'fail', `${url}: ${errorMessage(err)}`);
  }
}

async function checkMcpInitialize(fetchImpl: FetchLike, config: Config): Promise<OnboardCheck> {
  const url = mcpUrl(config.worker_url);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.api_token}`,
        Accept: 'application/json',
        'X-DeckAgent-Device-Id': config.preferred_device_id ?? config.device_id
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'deckagent-onboard', version: '0.0.1' }
        }
      })
    });

    const rawBody = await response.text();
    let parsed: z.infer<typeof JsonRpcInitializeResponseSchema> | null = null;
    try {
      const result = JsonRpcInitializeResponseSchema.safeParse(JSON.parse(rawBody));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }

    const version = parsed?.result?.serverInfo?.version;
    const ok = response.status === 200 && parsed?.result !== undefined && !parsed.error;
    return check(
      'mcp_initialize',
      'MCP initialize Bearer',
      ok ? 'pass' : 'fail',
      ok ? `server=${version ?? 'unknown'}` : `HTTP ${response.status}: ${parsed?.error?.message ?? rawBody.slice(0, 180)}`
    );
  } catch (err) {
    return check('mcp_initialize', 'MCP initialize Bearer', 'fail', errorMessage(err));
  }
}

function checkDaemon(paths: OnboardReport['paths'], config: Config | null, nowMs: number): OnboardCheck {
  const pid = readPid(paths.pidPath);
  if (pid === null) {
    return check('daemon_health', 'Daemon pid + health fresh', 'fail', `missing or invalid pid file: ${paths.pidPath}`);
  }
  if (!isProcessAlive(pid)) {
    return check('daemon_health', 'Daemon pid + health fresh', 'fail', `pid ${pid} is not running`);
  }
  if (!fs.existsSync(paths.healthPath)) {
    return check('daemon_health', 'Daemon pid + health fresh', 'fail', `missing health file: ${paths.healthPath}`);
  }

  let health: z.infer<typeof HealthFileSchema>;
  try {
    health = readJsonFile(paths.healthPath, HealthFileSchema);
  } catch (err) {
    return check('daemon_health', 'Daemon pid + health fresh', 'fail', `invalid health.json: ${errorMessage(err)}`);
  }

  const heartbeatMs = Date.parse(health.last_heartbeat_at);
  if (Number.isNaN(heartbeatMs)) {
    return check('daemon_health', 'Daemon pid + health fresh', 'fail', 'health last_heartbeat_at is invalid');
  }
  const heartbeatInterval = config?.heartbeat_interval ?? 15;
  const staleAfterSeconds = Math.max(2 * heartbeatInterval, 45);
  const ageSeconds = Math.max(0, (nowMs - heartbeatMs) / 1000);
  const fresh = ageSeconds <= staleAfterSeconds;
  const ok = health.ok && health.tunnel === 'connected' && fresh && health.pid === pid;
  const detail = [
    `pid=${pid}`,
    `health_pid=${health.pid}`,
    `tunnel=${health.tunnel}`,
    `ok=${String(health.ok)}`,
    `heartbeat=${ageSeconds.toFixed(1)}s ago`
  ].join(', ');

  return check(
    'daemon_health',
    'Daemon pid + health fresh',
    ok ? 'pass' : 'fail',
    fresh ? detail : `${detail}, stale>${staleAfterSeconds}s`
  );
}

function nextActions(config: Config | null): OnboardNextActions {
  return {
    ui: 'deckagent ui',
    connector_url: config ? mcpUrl(config.worker_url) : undefined,
    workspace: 'deckagent workspace use .'
  };
}

export async function collectOnboardReport(options: OnboardCollectOptions = {}): Promise<OnboardReport> {
  const paths = pathsForBaseDir(options.baseDir);
  const checks: OnboardCheck[] = [];
  const nowMs = options.now?.() ?? Date.now();
  let config: Config | null = null;
  let policy: Policy | null = null;

  if (!fs.existsSync(paths.configPath)) {
    checks.push(check('config', 'Config exists + parses', 'fail', `not found: ${paths.configPath}`));
  } else {
    try {
      config = readJsonFile(paths.configPath, ConfigSchema);
      checks.push(check('config', 'Config exists + parses', 'pass', paths.configPath));
    } catch (err) {
      checks.push(check('config', 'Config exists + parses', 'fail', errorMessage(err)));
    }
  }

  if (!fs.existsSync(paths.policyPath)) {
    checks.push(check('policy', 'Policy exists + parses', 'fail', `not found: ${paths.policyPath}`));
  } else {
    try {
      policy = readJsonFile(paths.policyPath, PolicySchema);
      const trustedCount = trustedDirectoryCount(policy);
      checks.push(
        check(
          'policy',
          'Policy exists + parses',
          trustedCount === 0 ? 'warn' : 'pass',
          trustedCount === 0
            ? 'trusted_directories is empty; use deckagent policy trust <path>'
            : `${paths.policyPath} (${trustedCount} trusted)`
        )
      );
    } catch (err) {
      checks.push(check('policy', 'Policy exists + parses', 'fail', errorMessage(err)));
    }
  }

  checks.push(checkDaemon(paths, config, nowMs));

  if (!config) {
    checks.push(check('worker_health', 'Worker /health', 'skip', 'config unavailable'));
    checks.push(check('mcp_initialize', 'MCP initialize Bearer', 'skip', 'config unavailable'));
    checks.push(check('smoke', 'Compact MCP smoke', 'skip', 'config unavailable'));
  } else {
    const fetchImpl = getFetch(options.fetch);
    checks.push(await checkWorkerHealth(fetchImpl, config));
    checks.push(await checkMcpInitialize(fetchImpl, config));

    if (options.skipSmoke) {
      checks.push(check('smoke', 'Compact MCP smoke', 'skip', '--skip-smoke'));
    } else {
      try {
        const daemonLikelyOnline = checks.find((result) => result.id === 'daemon_health')?.status === 'pass';
        const smoke = await runSmokeMatrix({
          baseUrl: config.worker_url,
          token: config.api_token,
          profiles: ['mcpplayground'],
          fetch: fetchImpl,
          config,
          policy: selectListDirectoryPolicy(policy),
          daemonLikelyOnline,
          compact: true
        });
        checks.push(
          check(
            'smoke',
            'Compact MCP smoke',
            smoke.ok ? 'pass' : 'fail',
            smoke.ok ? `${smoke.steps.filter((result) => result.status === 'pass').length} step(s) passed` : `${smoke.failed.length} step(s) failed`
          )
        );
        const failed = checks.filter((result) => result.status === 'fail');
        const warnings = checks.filter((result) => result.status === 'warn');
        return {
          ok: failed.length === 0,
          checks,
          failed,
          warnings,
          paths,
          next_actions: nextActions(config),
          smoke
        };
      } catch (err) {
        checks.push(check('smoke', 'Compact MCP smoke', 'fail', errorMessage(err)));
      }
    }
  }

  const failed = checks.filter((result) => result.status === 'fail');
  const warnings = checks.filter((result) => result.status === 'warn');
  return {
    ok: failed.length === 0,
    checks,
    failed,
    warnings,
    paths,
    next_actions: nextActions(config)
  };
}

function parseOnboardArgs(args: string[]): ParsedOnboardArgs {
  const parsed: ParsedOnboardArgs = {
    help: false,
    json: false,
    skipSmoke: false
  };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--skip-smoke') {
      parsed.skipSmoke = true;
    } else {
      throw new Error(`Unknown onboard option: ${arg}`);
    }
  }
  return parsed;
}

function printOnboardHelp(output: Output): void {
  output.log(`Usage: deckagent onboard [--skip-smoke] [--json]

Runs the first-run DeckAgent checklist: config, policy, daemon health,
Worker /health, MCP initialize, and a compact MCP smoke test.
`);
}

function printOnboardReport(report: OnboardReport, output: Output): void {
  output.log('DeckAgent onboard checklist');
  output.log('');
  for (const result of report.checks) {
    const mark = result.status.toUpperCase().padEnd(4);
    const detail = result.detail ? `  ${result.detail}` : '';
    output.log(`${mark}  ${result.label}${detail}`);
  }
  output.log('');
  if (report.warnings.length > 0) {
    output.log(`Warnings: ${report.warnings.length}`);
  }
  if (report.ok) {
    output.log('Onboard PASS.');
  } else {
    output.error(`Onboard FAIL: ${report.failed.length} check(s) failed.`);
  }
  output.log('');
  output.log('Next actions:');
  output.log(`  ${report.next_actions.ui}`);
  if (report.next_actions.connector_url) {
    output.log(`  Connector URL: ${report.next_actions.connector_url}`);
  }
  output.log(`  ${report.next_actions.workspace}`);
}

export async function runOnboardCommand(args: string[] = [], options: OnboardCommandOptions = {}): Promise<number> {
  const output = options.output ?? console;
  let parsed: ParsedOnboardArgs;
  try {
    parsed = parseOnboardArgs(args);
  } catch (err) {
    output.error(errorMessage(err));
    printOnboardHelp(output);
    return 1;
  }

  if (parsed.help) {
    printOnboardHelp(output);
    return 0;
  }

  const report = await collectOnboardReport({
    fetch: options.fetch,
    baseDir: options.baseDir,
    now: options.now,
    skipSmoke: parsed.skipSmoke
  });

  if (parsed.json) {
    output.log(JSON.stringify(report, null, 2));
  } else {
    printOnboardReport(report, output);
  }
  return report.ok ? 0 : 1;
}
