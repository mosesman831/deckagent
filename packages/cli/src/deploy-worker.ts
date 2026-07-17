import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getCliPackageRoot, getWorkerPackageCandidates } from './paths.js';

export interface WorkerConfig {
  workerName: string;
  accountTag: string | null;
  kvNamespaceId: string | null;
  apiToken: string;
}

const MISSING_WORKER_HINT =
  'Cloudflare Worker package not found. Run deckagent from the DeckAgent monorepo, run `npm run bundle:cli` to embed worker sources under packages/cli/assets/worker, or install a published @deckagent/cli that includes those assets.';

/**
 * Replace the KV namespace id for the DECK_KV binding.
 * Matches any existing id value (empty, placeholder, or real id).
 */
export function applyKvNamespaceId(text: string, kvNamespaceId: string): string {
  // binding then id (common wrangler.jsonc form)
  const bindingThenId =
    /("binding"\s*:\s*"DECK_KV"\s*,\s*"id"\s*:\s*")[^"]*(")/;
  if (bindingThenId.test(text)) {
    return text.replace(bindingThenId, `$1${kvNamespaceId}$2`);
  }

  // id then binding
  const idThenBinding =
    /("id"\s*:\s*")[^"]*("\s*,\s*"binding"\s*:\s*"DECK_KV")/;
  if (idThenBinding.test(text)) {
    return text.replace(idThenBinding, `$1${kvNamespaceId}$2`);
  }

  throw new Error(
    'Could not find DECK_KV kv_namespaces binding with an "id" field in wrangler.jsonc'
  );
}

export interface ResolveWorkerOptions {
  /** Override CLI package root (directory containing package.json / assets/). */
  cliPackageRoot?: string;
}

/**
 * Resolve the Cloudflare Worker package directory.
 * Order: monorepo sibling → packages/cli/assets/worker → clear error.
 */
export function resolveWorkerPackageDir(options: ResolveWorkerOptions = {}): string {
  const cliPackageRoot = options.cliPackageRoot ?? getCliPackageRoot();
  const candidates = getWorkerPackageCandidates(cliPackageRoot);
  const tried: string[] = [];

  for (const candidate of candidates) {
    tried.push(candidate);
    const wranglerPath = path.join(candidate, 'wrangler.jsonc');
    if (fs.existsSync(wranglerPath)) {
      return candidate;
    }
  }

  throw new Error(
    `${MISSING_WORKER_HINT}\nLooked for:\n${tried.map((p) => `  - ${p}`).join('\n')}`
  );
}

export function readWorkerConfigTemplate(): string {
  const workerDir = resolveWorkerPackageDir();
  const templatePath = path.join(workerDir, 'wrangler.jsonc');
  return fs.readFileSync(templatePath, 'utf-8');
}

/**
 * Write the KV namespace id into the real wrangler.jsonc used by `wrangler deploy`.
 * Backs up the previous file to wrangler.jsonc.bak and leaves the configured
 * file in place so subsequent deploys keep the user's KV id.
 */
export function writeWorkerConfig(config: WorkerConfig): string {
  const workerDir = resolveWorkerPackageDir();
  const configPath = path.join(workerDir, 'wrangler.jsonc');
  const backupPath = path.join(workerDir, 'wrangler.jsonc.bak');

  let text = fs.readFileSync(configPath, 'utf-8');

  if (config.kvNamespaceId) {
    text = applyKvNamespaceId(text, config.kvNamespaceId);
  }

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath);
  }

  fs.writeFileSync(configPath, text, 'utf-8');
  return configPath;
}

/** Restore wrangler.jsonc from wrangler.jsonc.bak if a backup exists. */
export function restoreWorkerConfig(): void {
  const workerDir = resolveWorkerPackageDir();
  const configPath = path.join(workerDir, 'wrangler.jsonc');
  const backupPath = path.join(workerDir, 'wrangler.jsonc.bak');
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, configPath);
    fs.unlinkSync(backupPath);
  }
}

export function runWranglerCommand(args: string[], cwd: string): string {
  const command = `npx wrangler ${args.join(' ')}`;
  return execSync(command, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

export function isWranglerLoggedIn(workerDir: string): boolean {
  try {
    execSync('npx wrangler whoami', { cwd: workerDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function loginWrangler(workerDir: string): void {
  console.log('Logging into Cloudflare via Wrangler...');
  execSync('npx wrangler login', { cwd: workerDir, stdio: 'inherit' });
}

export interface KVNamespace {
  id: string;
  title: string;
}

export function createKVNamespace(workerDir: string): KVNamespace {
  console.log('Creating KV namespace DECK_KV...');
  const output = execSync('npx wrangler kv namespace create "DECK_KV"', {
    cwd: workerDir,
    encoding: 'utf-8',
    stdio: 'pipe'
  });

  const idMatch = output.match(/id\s*=\s*"([a-f0-9]+)"/i) || output.match(/"id"\s*:\s*"([a-f0-9]+)"/i);
  const titleMatch = output.match(/title\s*=\s*"([^"]+)"/i) || output.match(/"title"\s*:\s*"([^"]+)"/i);

  if (!idMatch) {
    throw new Error('Could not parse KV namespace ID from wrangler output.\n' + output);
  }

  return { id: idMatch[1], title: titleMatch?.[1] ?? 'DECK_KV' };
}

export function setWranglerSecret(name: string, value: string, workerDir: string): void {
  console.log(`Setting wrangler secret ${name}...`);
  try {
    execSync(`npx wrangler secret put ${name}`, {
      cwd: workerDir,
      input: value + '\n',
      stdio: ['pipe', 'inherit', 'inherit']
    });
  } catch (err) {
    throw new Error(`Failed to set secret ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface DeployResult {
  url: string;
}

export function deployWorker(config: WorkerConfig): DeployResult {
  const workerDir = resolveWorkerPackageDir();

  if (!isWranglerLoggedIn(workerDir)) {
    loginWrangler(workerDir);
  }

  let kvId = config.kvNamespaceId;
  if (!kvId) {
    const kv = createKVNamespace(workerDir);
    kvId = kv.id;
  }

  // Writes into the real wrangler.jsonc (backed up once) and leaves KV id in place.
  writeWorkerConfig({ ...config, kvNamespaceId: kvId });

  setWranglerSecret('API_TOKEN', config.apiToken, workerDir);

  console.log('Deploying worker...');
  const output = execSync('npx wrangler deploy', {
    cwd: workerDir,
    encoding: 'utf-8',
    stdio: 'pipe'
  });

  const urlMatch = output.match(/https:\/\/([a-z0-9-]+\.workers\.dev|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)/i);
  if (!urlMatch) {
    throw new Error('Could not parse deployed worker URL from wrangler output.\n' + output);
  }

  return { url: urlMatch[0] };
}
