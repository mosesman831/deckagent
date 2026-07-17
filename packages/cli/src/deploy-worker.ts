import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WorkerConfig {
  workerName: string;
  accountTag: string | null;
  kvNamespaceId: string | null;
  apiToken: string;
}

export function resolveWorkerPackageDir(): string {
  return path.resolve(__dirname, '..', '..', 'cloudflare-worker');
}

export function readWorkerConfigTemplate(): string {
  const workerDir = resolveWorkerPackageDir();
  const templatePath = path.join(workerDir, 'wrangler.jsonc');
  return fs.readFileSync(templatePath, 'utf-8');
}

export function writeWorkerConfig(config: WorkerConfig): string {
  const workerDir = resolveWorkerPackageDir();
  const templatePath = path.join(workerDir, 'wrangler.jsonc');
  const stagingPath = path.join(workerDir, 'wrangler.jsonc.cli');

  let text = fs.readFileSync(templatePath, 'utf-8');

  if (config.kvNamespaceId) {
    text = text.replace(
      /"kv_namespaces"\s*:\s*\[\s*\{\s*"binding"\s*:\s*"DECK_KV"\s*,\s*"id"\s*:\s*""\s*\}\s*\]/,
      `"kv_namespaces": [{ "binding": "DECK_KV", "id": "${config.kvNamespaceId}" }]`
    );
  }

  fs.writeFileSync(stagingPath, text, 'utf-8');
  return stagingPath;
}

export function restoreWorkerConfig(): void {
  const workerDir = resolveWorkerPackageDir();
  const stagingPath = path.join(workerDir, 'wrangler.jsonc.cli');
  if (fs.existsSync(stagingPath)) {
    fs.unlinkSync(stagingPath);
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

  const stagingPath = writeWorkerConfig({ ...config, kvNamespaceId: kvId });

  try {
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
  } finally {
    restoreWorkerConfig();
  }
}
