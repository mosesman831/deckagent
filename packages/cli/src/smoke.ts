import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ConfigSchema,
  PolicySchema,
  getConfigDir,
  getConfigPath,
  getPolicyPath,
  readConfig as readConfigFile,
  readPolicy as readPolicyFile,
  type Config,
  type Policy
} from './configure.js';
import { commandLine, sectionTitle, statusText, supportsColor, type Output } from './ux.js';

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<Response>;

const SmokeProfileSchema = z.enum(['mcpplayground', 'cursor', 'claude-desktop']);
export type SmokeProfileName = z.infer<typeof SmokeProfileSchema>;

const CLIENT_PROFILES: Record<SmokeProfileName, { name: SmokeProfileName; version: string }> = {
  cursor: { name: 'cursor', version: '1.0.0' },
  'claude-desktop': { name: 'claude-desktop', version: '0.1.0' },
  mcpplayground: { name: 'mcpplayground', version: '0.0.1' }
};

const HealthFileSchema = z.object({
  ok: z.boolean(),
  pid: z.number().int(),
  device_id: z.string().min(1),
  tunnel: z.enum(['connected', 'connecting', 'disconnected']),
  last_heartbeat_at: z.string().datetime(),
  worker_url: z.string().url(),
  version: z.string().min(1)
}).passthrough();

const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.record(z.unknown()).optional()
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional()
});

type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export interface SmokeStepResult {
  profile: SmokeProfileName;
  step: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  hint?: string;
  next_command?: string;
}

export interface SmokeReport {
  ok: boolean;
  baseUrl: string;
  mcpUrl: string;
  profiles: SmokeProfileName[];
  daemonLikelyOnline: boolean;
  steps: SmokeStepResult[];
  failed: SmokeStepResult[];
  skipped: SmokeStepResult[];
}

export interface SmokeMatrixOptions {
  baseUrl: string;
  token: string;
  profiles?: SmokeProfileName[];
  fetch?: FetchLike;
  config?: Config | null;
  policy?: Policy | null;
  daemonLikelyOnline?: boolean;
  compact?: boolean;
}

export interface SmokeCommandOptions {
  fetch?: FetchLike;
  readConfig?: () => Config;
  readPolicy?: () => Policy;
  output?: Output;
  baseDir?: string;
  now?: () => number;
  daemonLikelyOnline?: boolean;
}

interface ParsedSmokeArgs {
  help: boolean;
  profile?: SmokeProfileName;
  baseUrl?: string;
  token?: string;
}

interface McpCallResult {
  status: number;
  json: JsonRpcResponse | null;
  rawBody: string;
}

function getFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch !== 'function') {
    throw new Error('This command requires Node.js fetch support. Use Node 18 or newer.');
  }
  return fetch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeMcpUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Worker URL is required.');
  }
  return trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
}

function readJsonFile<T>(filePath: string, schema: { parse: (value: unknown) => T }): T {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return schema.parse(JSON.parse(raw));
}

function readConfigFromBaseDir(baseDir?: string): Config {
  if (!baseDir) {
    return readConfigFile();
  }
  return readJsonFile(path.join(baseDir, 'config.json'), ConfigSchema);
}

function readPolicyFromBaseDir(baseDir?: string): Policy {
  if (!baseDir) {
    return readPolicyFile();
  }
  return readJsonFile(path.join(baseDir, 'policy.json'), PolicySchema);
}

function readOptionalPolicy(readPolicy: () => Policy): Policy | null {
  try {
    return readPolicy();
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDaemonLikelyOnline(options: {
  baseDir?: string;
  config?: Config | null;
  now?: () => number;
} = {}): boolean {
  const baseDir = options.baseDir ?? getConfigDir();
  const healthPath = path.join(baseDir, 'health.json');
  const pidPath = path.join(baseDir, 'daemon.pid');
  if (!fs.existsSync(healthPath) || !fs.existsSync(pidPath)) {
    return false;
  }

  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || !isProcessAlive(pid)) {
    return false;
  }

  let parsed: z.infer<typeof HealthFileSchema>;
  try {
    parsed = HealthFileSchema.parse(JSON.parse(fs.readFileSync(healthPath, 'utf-8')));
  } catch {
    return false;
  }

  const nowMs = options.now?.() ?? Date.now();
  const heartbeatMs = Date.parse(parsed.last_heartbeat_at);
  if (Number.isNaN(heartbeatMs)) {
    return false;
  }
  const heartbeatInterval = options.config?.heartbeat_interval ?? 15;
  const staleAfterMs = Math.max(2 * heartbeatInterval, 45) * 1000;
  return parsed.ok && parsed.tunnel === 'connected' && nowMs - heartbeatMs <= staleAfterMs;
}

async function mcpCall(
  fetchImpl: FetchLike,
  mcpUrl: string,
  token: string,
  deviceId: string | undefined,
  id: number,
  method: string,
  params: Record<string, unknown>
): Promise<McpCallResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  };
  if (deviceId) {
    headers['X-DeckAgent-Device-Id'] = deviceId;
  }

  const response = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    })
  });

  const rawBody = await response.text();
  let json: JsonRpcResponse | null = null;
  try {
    const parsed = JSON.parse(rawBody);
    const result = JsonRpcResponseSchema.safeParse(parsed);
    json = result.success ? result.data : null;
  } catch {
    json = null;
  }

  return { status: response.status, json, rawBody };
}

function hasResult(result: McpCallResult): boolean {
  return result.json?.result !== undefined && result.json.error === undefined;
}

function failDetail(result: McpCallResult): string {
  const message = result.json?.error?.message;
  if (message) {
    return `status=${result.status} error=${message}`;
  }
  return `status=${result.status} body=${result.rawBody.slice(0, 180)}`;
}

function step(
  profile: SmokeProfileName,
  stepName: string,
  status: SmokeStepResult['status'],
  detail?: string
): SmokeStepResult {
  return detail ? { profile, step: stepName, status, detail } : { profile, step: stepName, status };
}

function smokeRemediation(result: SmokeStepResult): Pick<SmokeStepResult, 'hint' | 'next_command'> {
  if (result.step === 'initialize') {
    return {
      hint: 'The Worker /mcp endpoint must accept the configured Bearer token.',
      next_command: 'deckagent token rotate --deploy'
    };
  }
  if (result.step === 'tools/list') {
    return {
      hint: 'The Worker should expose the static catalog and proxy daemon tools when the device is online.',
      next_command: 'deckagent doctor --strict'
    };
  }
  if (result.step === 'resources/list' || result.step.startsWith('resources/read')) {
    return {
      hint: 'Resource calls validate Worker JSON-RPC routing and static DeckAgent metadata.',
      next_command: 'deckagent smoke --profile mcpplayground'
    };
  }
  if (result.step === 'prompts/list') {
    return {
      hint: 'Prompt catalog metadata may be stale or missing from the deployed Worker.',
      next_command: 'deckagent setup'
    };
  }
  if (result.step.startsWith('tools/call')) {
    return {
      hint: 'Tool calls require a reachable daemon plus a workspace or trusted directory when filesystem tools run.',
      next_command: 'deckagent daemon --foreground'
    };
  }
  return {
    hint: 'Fix the failed smoke step, then rerun the matrix.',
    next_command: 'deckagent smoke'
  };
}

function addFailedStepHints(steps: SmokeStepResult[]): SmokeStepResult[] {
  return steps.map((result) => {
    if (result.status !== 'fail') {
      return result;
    }
    const remediation = smokeRemediation(result);
    return {
      ...result,
      hint: result.hint ?? remediation.hint,
      next_command: result.next_command ?? remediation.next_command
    };
  });
}

function resourceReadUri(resources: unknown[]): string {
  const records = resources.map(asRecord).filter((value): value is Record<string, unknown> => value !== null);
  const about = records.find((resource) => resource.uri === 'deckagent://about');
  if (about) {
    return 'deckagent://about';
  }
  const devices = records.find((resource) => resource.uri === 'deckagent://devices');
  if (devices) {
    return 'deckagent://devices';
  }
  const first = records.find((resource) => typeof resource.uri === 'string');
  return typeof first?.uri === 'string' ? first.uri : 'deckagent://about';
}

function selectListDirectoryPath(config: Config | null | undefined, policy: Policy | null | undefined): string | null {
  if (config?.workspace?.root) {
    return '.';
  }
  const trusted = policy?.trusted_directories?.find((dir) => dir.trim().length > 0);
  if (trusted) {
    return trusted;
  }
  const allowed = policy?.allowed_directories?.find((dir) => dir.trim().length > 0);
  return allowed ?? null;
}

async function runProfileSmoke(
  profile: SmokeProfileName,
  options: {
    fetchImpl: FetchLike;
    mcpUrl: string;
    token: string;
    config?: Config | null;
    policy?: Policy | null;
    daemonLikelyOnline: boolean;
    compact: boolean;
  }
): Promise<SmokeStepResult[]> {
  const results: SmokeStepResult[] = [];
  const client = CLIENT_PROFILES[profile];
  const deviceId = options.config?.preferred_device_id ?? options.config?.device_id;
  let id = 1;

  try {
    const result = await mcpCall(options.fetchImpl, options.mcpUrl, options.token, deviceId, id++, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: client.name, version: client.version }
    });
    const root = asRecord(result.json?.result);
    const serverInfo = asRecord(root?.serverInfo);
    const ok = result.status === 200 && hasResult(result) && typeof serverInfo?.version === 'string';
    results.push(step(profile, 'initialize', ok ? 'pass' : 'fail', ok ? `server=${serverInfo?.version}` : failDetail(result)));
  } catch (err) {
    results.push(step(profile, 'initialize', 'fail', errorMessage(err)));
  }

  try {
    const result = await mcpCall(options.fetchImpl, options.mcpUrl, options.token, deviceId, id++, 'tools/list', {});
    const root = asRecord(result.json?.result);
    const tools = asArray(root?.tools);
    const names = tools
      ?.map((tool) => asRecord(tool)?.name)
      .filter((name): name is string => typeof name === 'string') ?? [];
    const minTools = options.daemonLikelyOnline ? 15 : 1;
    const ok = result.status === 200 && hasResult(result) && names.length >= minTools && names.includes('get_environment');
    results.push(
      step(
        profile,
        'tools/list',
        ok ? 'pass' : 'fail',
        ok ? `${names.length} tools` : `status=${result.status} count=${names.length}`
      )
    );
  } catch (err) {
    results.push(step(profile, 'tools/list', 'fail', errorMessage(err)));
  }

  let readUri = 'deckagent://about';
  try {
    const result = await mcpCall(options.fetchImpl, options.mcpUrl, options.token, deviceId, id++, 'resources/list', {});
    const root = asRecord(result.json?.result);
    const resources = asArray(root?.resources);
    if (resources) {
      readUri = resourceReadUri(resources);
    }
    const ok = result.status === 200 && hasResult(result) && !!resources && resources.length > 0;
    results.push(
      step(
        profile,
        'resources/list',
        ok ? 'pass' : 'fail',
        ok ? `${resources?.length ?? 0} resources` : failDetail(result)
      )
    );
  } catch (err) {
    results.push(step(profile, 'resources/list', 'fail', errorMessage(err)));
  }

  try {
    const result = await mcpCall(options.fetchImpl, options.mcpUrl, options.token, deviceId, id++, 'resources/read', {
      uri: readUri
    });
    const root = asRecord(result.json?.result);
    const contents = asArray(root?.contents);
    const first = contents?.[0] ? asRecord(contents[0]) : null;
    const ok = result.status === 200 && hasResult(result) && !!contents && typeof first?.text === 'string';
    results.push(step(profile, `resources/read ${readUri}`, ok ? 'pass' : 'fail', ok ? undefined : failDetail(result)));
  } catch (err) {
    results.push(step(profile, `resources/read ${readUri}`, 'fail', errorMessage(err)));
  }

  try {
    const result = await mcpCall(options.fetchImpl, options.mcpUrl, options.token, deviceId, id++, 'prompts/list', {});
    const root = asRecord(result.json?.result);
    const prompts = asArray(root?.prompts);
    const names = prompts
      ?.map((prompt) => asRecord(prompt)?.name)
      .filter((name): name is string => typeof name === 'string') ?? [];
    const ok = result.status === 200 && hasResult(result) && names.includes('deckagent_system');
    results.push(step(profile, 'prompts/list', ok ? 'pass' : 'fail', ok ? `${names.length} prompts` : failDetail(result)));
  } catch (err) {
    results.push(step(profile, 'prompts/list', 'fail', errorMessage(err)));
  }

  if (!options.daemonLikelyOnline) {
    results.push(step(profile, 'tools/call get_environment', 'skip', 'daemon not likely online'));
    results.push(step(profile, 'tools/call list_directory', 'skip', 'daemon not likely online'));
    return results;
  }

  try {
    const result = await mcpCall(options.fetchImpl, options.mcpUrl, options.token, deviceId, id++, 'tools/call', {
      name: 'get_environment',
      arguments: {}
    });
    const root = asRecord(result.json?.result);
    const content = asArray(root?.content);
    const ok = result.status === 200 && hasResult(result) && !!content && root?.isError !== true;
    results.push(step(profile, 'tools/call get_environment', ok ? 'pass' : 'fail', ok ? undefined : failDetail(result)));
  } catch (err) {
    results.push(step(profile, 'tools/call get_environment', 'fail', errorMessage(err)));
  }

  const directoryPath = selectListDirectoryPath(options.config, options.policy);
  if (!directoryPath) {
    results.push(step(profile, 'tools/call list_directory', 'skip', 'no workspace or trusted directory configured'));
    return results;
  }

  try {
    const result = await mcpCall(options.fetchImpl, options.mcpUrl, options.token, deviceId, id++, 'tools/call', {
      name: 'list_directory',
      arguments: { path: directoryPath }
    });
    const root = asRecord(result.json?.result);
    const content = asArray(root?.content);
    const ok = result.status === 200 && hasResult(result) && !!content && root?.isError !== true;
    results.push(
      step(
        profile,
        `tools/call list_directory ${JSON.stringify(directoryPath)}`,
        ok ? 'pass' : 'fail',
        ok ? undefined : failDetail(result)
      )
    );
  } catch (err) {
    results.push(step(profile, `tools/call list_directory ${JSON.stringify(directoryPath)}`, 'fail', errorMessage(err)));
  }

  return results;
}

export async function runSmokeMatrix(options: SmokeMatrixOptions): Promise<SmokeReport> {
  const fetchImpl = getFetch(options.fetch);
  const profiles = options.profiles && options.profiles.length > 0 ? options.profiles : [...SmokeProfileSchema.options];
  const mcpUrl = normalizeMcpUrl(options.baseUrl);
  const steps: SmokeStepResult[] = [];

  for (const profile of profiles) {
    steps.push(
      ...(await runProfileSmoke(profile, {
        fetchImpl,
        mcpUrl,
        token: options.token,
        config: options.config,
        policy: options.policy,
        daemonLikelyOnline: options.daemonLikelyOnline ?? false,
        compact: options.compact ?? false
      }))
    );
  }

  const stepsWithHints = addFailedStepHints(steps);
  const failed = stepsWithHints.filter((result) => result.status === 'fail');
  const skipped = stepsWithHints.filter((result) => result.status === 'skip');
  return {
    ok: failed.length === 0,
    baseUrl: options.baseUrl,
    mcpUrl,
    profiles,
    daemonLikelyOnline: options.daemonLikelyOnline ?? false,
    steps: stepsWithHints,
    failed,
    skipped
  };
}

function parseSmokeArgs(args: string[]): ParsedSmokeArgs {
  const parsed: ParsedSmokeArgs = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true;
    } else if (arg === '--profile') {
      const raw = args[++index];
      const result = SmokeProfileSchema.safeParse(raw);
      if (!result.success) {
        throw new Error('--profile must be one of: mcpplayground, cursor, claude-desktop');
      }
      parsed.profile = result.data;
    } else if (arg === '--base-url' || arg === '--url' || arg === '-u') {
      const raw = args[++index];
      if (!raw || raw.startsWith('--')) {
        throw new Error(`${arg} requires a URL`);
      }
      parsed.baseUrl = raw;
    } else if (arg === '--token' || arg === '-t') {
      const raw = args[++index];
      if (!raw || raw.startsWith('--')) {
        throw new Error(`${arg} requires a token`);
      }
      parsed.token = raw;
    } else {
      throw new Error(`Unknown smoke option: ${arg}`);
    }
  }
  return parsed;
}

function printSmokeHelp(output: Output): void {
  output.log(`Usage: deckagent smoke [--profile mcpplayground|cursor|claude-desktop] [--base-url URL] [--token TOKEN]

Runs an MCP JSON-RPC smoke matrix against the Worker /mcp endpoint.
Defaults read worker_url and api_token from ~/.deckagent/config.json.
`);
}

export function printSmokeReport(report: SmokeReport, output: Output = console): void {
  const colorEnabled = supportsColor(output);
  output.log(sectionTitle('DeckAgent MCP Smoke', colorEnabled));
  output.log('');
  output.log(sectionTitle('Target', colorEnabled));
  output.log(`URL: ${report.mcpUrl}`);
  output.log(`Profiles: ${report.profiles.join(', ')}`);
  output.log(`Daemon checks: ${report.daemonLikelyOnline ? 'enabled' : 'skipped (daemon not likely online)'}`);
  output.log('');

  let currentProfile: SmokeProfileName | null = null;
  for (const result of report.steps) {
    if (result.profile !== currentProfile) {
      currentProfile = result.profile;
      output.log(sectionTitle(`Profile: ${currentProfile}`, colorEnabled));
    }
    const mark = statusText(result.status, colorEnabled);
    const detail = result.detail ? `  (${result.detail})` : '';
    output.log(`  ${mark}  ${result.step}${detail}`);
    if (result.status === 'fail' && result.hint) {
      output.log(`        Hint: ${result.hint}`);
    }
    if (result.status === 'fail' && result.next_command) {
      output.log(`        Next: ${commandLine(result.next_command, colorEnabled)}`);
    }
  }

  output.log('');
  output.log(sectionTitle('Summary', colorEnabled));
  if (report.ok) {
    output.log('Smoke PASS.');
  } else {
    output.error(`Smoke FAIL: ${report.failed.length} step(s) failed.`);
    output.log(`Next command: ${commandLine('deckagent doctor --strict', colorEnabled)}`);
  }
}

export async function runSmokeCommand(args: string[] = [], options: SmokeCommandOptions = {}): Promise<number> {
  const output = options.output ?? console;
  let parsed: ParsedSmokeArgs;
  try {
    parsed = parseSmokeArgs(args);
  } catch (err) {
    output.error(errorMessage(err));
    printSmokeHelp(output);
    return 1;
  }

  if (parsed.help) {
    printSmokeHelp(output);
    return 0;
  }

  let config: Config | null = null;
  let policy: Policy | null = null;
  const readConfig = options.readConfig ?? (() => readConfigFromBaseDir(options.baseDir));
  const readPolicy = options.readPolicy ?? (() => readPolicyFromBaseDir(options.baseDir));

  if (!parsed.baseUrl || !parsed.token) {
    try {
      config = readConfig();
    } catch (err) {
      output.error(`Unable to read config.json for smoke defaults: ${errorMessage(err)}`);
      return 1;
    }
  } else {
    try {
      config = readConfig();
    } catch {
      config = null;
    }
  }

  policy = readOptionalPolicy(readPolicy);
  const baseUrl = parsed.baseUrl ?? config?.worker_url;
  const token = parsed.token ?? config?.api_token;
  if (!baseUrl || !token) {
    output.error('Missing Worker URL or API token. Use --base-url and --token, or run deckagent setup first.');
    return 1;
  }

  const daemonLikelyOnline =
    options.daemonLikelyOnline ??
    readDaemonLikelyOnline({ baseDir: options.baseDir, config, now: options.now });
  const report = await runSmokeMatrix({
    baseUrl,
    token,
    profiles: parsed.profile ? [parsed.profile] : undefined,
    fetch: options.fetch,
    config,
    policy,
    daemonLikelyOnline
  });
  printSmokeReport(report, output);
  return report.ok ? 0 : 1;
}

export function defaultSmokePaths(): { configPath: string; policyPath: string } {
  return {
    configPath: getConfigPath(),
    policyPath: getPolicyPath()
  };
}
