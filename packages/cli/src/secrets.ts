import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';
import { getConfigDir } from './configure.js';

export const SecretEntrySchema = z.object({
  value: z.string().min(1),
  created_at: z.string().min(1)
});

export const SecretsFileSchema = z.object({
  version: z.literal(1).default(1),
  secrets: z.record(z.string(), SecretEntrySchema).default({})
});

export type SecretEntry = z.infer<typeof SecretEntrySchema>;
export type SecretsFile = z.infer<typeof SecretsFileSchema>;

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getSecretsPath(baseDir?: string): string {
  const root = baseDir ?? getConfigDir();
  return path.join(root, 'secrets.json');
}

export function emptySecretsFile(): SecretsFile {
  return { version: 1, secrets: {} };
}

export function readSecretsFile(baseDir?: string): SecretsFile {
  const filePath = getSecretsPath(baseDir);
  if (!fs.existsSync(filePath)) {
    return emptySecretsFile();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return SecretsFileSchema.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to read secrets file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function writeSecretsFile(data: SecretsFile, baseDir?: string): void {
  const root = baseDir ?? getConfigDir();
  fs.mkdirSync(root, { recursive: true });
  const filePath = getSecretsPath(baseDir);
  const parsed = SecretsFileSchema.parse(data);
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on some Windows setups; mode on create is best-effort there.
  }
}

export function validateSecretName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Secret name is required.');
  }
  if (!SECRET_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid secret name "${trimmed}". Use letters, digits, and underscores (must start with a letter or _).`
    );
  }
  return trimmed;
}

/**
 * Set or overwrite a secret. Returns whether this created a new entry.
 */
export function setSecret(name: string, value: string, baseDir?: string): { created: boolean } {
  const key = validateSecretName(name);
  const trimmedValue = value.replace(/\r?\n$/, '');
  if (!trimmedValue) {
    throw new Error('Secret value cannot be empty.');
  }

  const file = readSecretsFile(baseDir);
  const created = !(key in file.secrets);
  file.secrets[key] = {
    value: trimmedValue,
    created_at: new Date().toISOString()
  };
  writeSecretsFile(file, baseDir);
  return { created };
}

/** List secret names only (never values). */
export function listSecrets(baseDir?: string): string[] {
  const file = readSecretsFile(baseDir);
  return Object.keys(file.secrets).sort();
}

/**
 * Delete a secret by name.
 * @returns true if it existed and was removed
 */
export function deleteSecret(name: string, baseDir?: string): boolean {
  const key = validateSecretName(name);
  const file = readSecretsFile(baseDir);
  if (!(key in file.secrets)) {
    return false;
  }
  delete file.secrets[key];
  writeSecretsFile(file, baseDir);
  return true;
}

/**
 * Read secret value: from stdin when not a TTY, otherwise prompt (no echo when possible).
 */
export async function readSecretValue(prompt = 'Enter secret value: '): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
  }

  return promptHidden(prompt);
}

function promptHidden(query: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return new Promise((resolve, reject) => {
      stdout.write(query);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let input = '';

      const cleanup = (): void => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
      };

      const onData = (char: string): void => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          cleanup();
          stdout.write('\n');
          resolve(input);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1);
          return;
        }
        if (char === '\u0015') {
          // Ctrl+U clear line
          input = '';
          return;
        }
        if (char.length === 1 && char >= ' ') {
          input += char;
        }
      };

      stdin.on('data', onData);
    });
  }

  // Fallback: readline with echo (non-raw TTY)
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runSecretCommand(
  args: string[],
  options: {
    baseDir?: string;
    readValue?: () => Promise<string>;
  } = {}
): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(`Usage:
  deckagent secret set <NAME>     Set a secret (prompt or stdin)
  deckagent secret list           List secret names
  deckagent secret delete <NAME>  Delete a secret
`);
    return;
  }

  const baseDir = options.baseDir;

  switch (sub) {
    case 'set': {
      const name = args[1];
      if (!name) {
        throw new Error('Missing name. Usage: deckagent secret set <NAME>');
      }
      const key = validateSecretName(name);
      const readValue = options.readValue ?? readSecretValue;
      const value = await readValue();
      const { created } = setSecret(key, value, baseDir);
      console.log(created ? `Secret "${key}" set.` : `Secret "${key}" updated.`);
      break;
    }
    case 'list': {
      const names = listSecrets(baseDir);
      if (names.length === 0) {
        console.log('(no secrets)');
      } else {
        for (const name of names) {
          console.log(name);
        }
      }
      break;
    }
    case 'delete': {
      const name = args[1];
      if (!name) {
        throw new Error('Missing name. Usage: deckagent secret delete <NAME>');
      }
      const key = validateSecretName(name);
      const removed = deleteSecret(key, baseDir);
      if (!removed) {
        throw new Error(`Secret "${key}" not found.`);
      }
      console.log(`Secret "${key}" deleted.`);
      break;
    }
    default:
      throw new Error(`Unknown secret command: ${sub}. Use: set | list | delete`);
  }
}
