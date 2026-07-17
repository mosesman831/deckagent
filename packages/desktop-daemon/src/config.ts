import { z } from "zod";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ConfigPathSchema = z.string();

export const ConfigSchema = z.object({
  device_id: z.string().uuid(),
  token: z.string().min(32),
  worker_url: z.string().url(),
  device_name: z.string().min(1),
  heartbeat_interval: z.number().int().min(5).max(300).default(15),
  tool_timeout: z.number().int().min(1).max(300).default(60),
  auto_connect: z.boolean().default(true),
  log_level: z.enum(["info", "debug", "error", "warn"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function getConfigPath(): string {
  const envPath = process.env.DECKAGENT_CONFIG;
  if (envPath) {
    return ConfigPathSchema.parse(envPath);
  }
  return join(homedir(), ".deckagent", "config.json");
}

export function readConfig(path = getConfigPath()): Config {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Run 'deckagent setup' first.`);
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read config file: ${path} (${humanError(err)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config file contains invalid JSON: ${path}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }

  return result.data;
}

export function writeConfig(config: Config, path = getConfigPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Cannot write invalid config: ${result.error.message}`);
  }

  try {
    writeFileSync(path, JSON.stringify(result.data, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    throw new Error(`Failed to write config file: ${path} (${humanError(err)})`);
  }
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
