import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { readConfig, writeConfig, maskSecret, type Config } from './configure.js';
import { resolveWorkerPackageDir } from './deploy-worker.js';

export interface TokenRotateOptions {
  deploy: boolean;
}

export interface TokenRotateResult {
  previousToken: string;
  newToken: string;
  deployed: boolean;
}

export interface TokenCommandDeps {
  readConfig?: () => Config;
  writeConfig?: (config: Config) => void;
  generateToken?: () => string;
  deploySecret?: (token: string) => void;
  isWranglerAvailable?: () => boolean;
  resolveWorkerDir?: () => string;
  writeLine?: (line: string) => void;
}

export function generateApiToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function parseTokenRotateOptions(args: string[]): TokenRotateOptions {
  const options: TokenRotateOptions = { deploy: false };
  for (const arg of args) {
    if (arg === '--deploy') {
      options.deploy = true;
    } else {
      throw new Error(`Unknown token rotate option: ${arg}`);
    }
  }
  return options;
}

function humanError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultIsWranglerAvailable(): boolean {
  try {
    const workerDir = resolveWorkerPackageDir();
    execSync('npx --no-install wrangler --version', { cwd: workerDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function defaultDeploySecret(token: string): void {
  const workerDir = resolveWorkerPackageDir();
  execSync('npx --no-install wrangler secret put API_TOKEN', {
    cwd: workerDir,
    input: `${token}\n`,
    stdio: ['pipe', 'inherit', 'inherit']
  });
}

function defaultResolveWorkerDir(): string {
  return resolveWorkerPackageDir();
}

function printWranglerInstructions(writeLine: (line: string) => void, resolveWorkerDir: () => string): void {
  let workerDir = 'packages/cloudflare-worker';
  try {
    workerDir = resolveWorkerDir();
  } catch {
    // Published installs may not have a monorepo path; the command itself is still the same.
  }

  writeLine('');
  writeLine('Update the Cloudflare Worker secret before using the new Bearer token:');
  writeLine(`  cd ${workerDir}`);
  writeLine('  npx --no-install wrangler secret put API_TOKEN');
  writeLine('  # Paste the new api_token from ~/.deckagent/config.json when prompted.');
  writeLine('');
  writeLine('Also update every MCP connector to use the new Bearer token.');
}

export function rotateApiToken(config: Config, generateToken: () => string = generateApiToken): Config {
  return {
    ...config,
    api_token: generateToken()
  };
}

export async function runTokenCommand(args: string[], deps: TokenCommandDeps = {}): Promise<TokenRotateResult | void> {
  const subcommand = args[0];
  const writeLine = deps.writeLine ?? ((line: string) => console.log(line));

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    writeLine(tokenHelpText());
    return;
  }

  if (subcommand !== 'rotate') {
    throw new Error(`Unknown token command: ${subcommand}`);
  }

  if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
    writeLine(tokenHelpText());
    return;
  }

  const options = parseTokenRotateOptions(args.slice(1));
  const read = deps.readConfig ?? readConfig;
  const write = deps.writeConfig ?? writeConfig;
  const generateToken = deps.generateToken ?? generateApiToken;
  const isWranglerAvailable = deps.isWranglerAvailable ?? defaultIsWranglerAvailable;
  const deploySecret = deps.deploySecret ?? defaultDeploySecret;
  const resolveWorkerDir = deps.resolveWorkerDir ?? defaultResolveWorkerDir;

  const current = read();
  const updated = rotateApiToken(current, generateToken);
  write(updated);

  writeLine(`Rotated local api_token in ~/.deckagent/config.json (${maskSecret(current.api_token)} -> ${maskSecret(updated.api_token)}).`);

  let deployed = false;
  if (options.deploy) {
    if (!isWranglerAvailable()) {
      writeLine('Wrangler is not available; Worker secret was not updated automatically.');
      printWranglerInstructions(writeLine, resolveWorkerDir);
      return {
        previousToken: current.api_token,
        newToken: updated.api_token,
        deployed
      };
    }

    try {
      deploySecret(updated.api_token);
      deployed = true;
      writeLine('Updated Cloudflare Worker secret API_TOKEN with Wrangler.');
    } catch (err) {
      throw new Error(
        `Local token was rotated, but updating the Worker secret failed: ${humanError(err)}\n` +
          'Run `deckagent token rotate` without --deploy to print manual Wrangler instructions.'
      );
    }
  } else {
    printWranglerInstructions(writeLine, resolveWorkerDir);
  }

  return {
    previousToken: current.api_token,
    newToken: updated.api_token,
    deployed
  };
}

export function tokenHelpText(): string {
  return `Usage:
  deckagent token rotate [--deploy]

Rotates the Bearer API token stored in ~/.deckagent/config.json.
Without --deploy, DeckAgent prints Wrangler instructions so you can update the Worker secret manually.
With --deploy, DeckAgent updates the Worker API_TOKEN secret when Wrangler is available.`;
}
