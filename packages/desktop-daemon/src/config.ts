import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

/**
 * Zod schema for `~/.deckagent/config.json`. Defaults mirror SPEC §3.3.
 */
export const ConfigSchema = z.object({
  device_id: z.string().uuid(),
  token: z.string(),
  worker_url: z.string().url(),
  device_name: z.string(),
  heartbeat_interval: z.number().default(15),
  tool_timeout: z.number().default(60),
  auto_connect: z.boolean().default(true),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Root DeckAgent directory: `~/.deckagent`. */
export function getConfigDir(): string {
  return path.join(os.homedir(), '.deckagent');
}

/** Absolute path to the config file: `~/.deckagent/config.json`. */
export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/** Create `~/.deckagent` if it does not exist. */
export function ensureConfigDir(): string {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read, parse, and validate `~/.deckagent/config.json`.
 * Throws a human-readable error if the file is missing or invalid.
 */
export function loadConfig(): Config {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}. Run \`deckagent setup\` to create it.`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read config at ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config at ${configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Config at ${configPath} is invalid:\n${issues}`);
  }
  return result.data;
}

/**
 * Validate and write config to `~/.deckagent/config.json` as pretty JSON.
 * Ensures the directory exists first.
 */
export function saveConfig(config: Config): void {
  const validated = ConfigSchema.parse(config);
  ensureConfigDir();
  fs.writeFileSync(getConfigPath(), JSON.stringify(validated, null, 2) + '\n', 'utf8');
}
