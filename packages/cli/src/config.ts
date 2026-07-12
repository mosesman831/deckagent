import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

export const configSchema = z.object({
  device_id: z.string().uuid(),
  token: z.string().min(1),
  worker_url: z.string().url(),
  device_name: z.string().min(1),
  heartbeat_interval: z.number().positive().default(15),
  tool_timeout: z.number().positive().default(60),
  auto_connect: z.boolean().default(true),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info")
});

export type DeckAgentConfig = z.infer<typeof configSchema>;

export const policySchema = z.object({
  allowed_directories: z.array(z.string()).default([homedir()]),
  blocked_commands: z.array(z.string()).default(["rm -rf /", "mkfs", "shutdown"]),
  require_confirmation: z.boolean().default(false),
  read_only: z.boolean().default(false)
});

export type DeckAgentPolicy = z.infer<typeof policySchema>;

export function getConfigDir(home = homedir()): string {
  return join(home, ".deckagent");
}

export function getConfigPath(home = homedir()): string {
  return join(getConfigDir(home), "config.json");
}

export function getPolicyPath(home = homedir()): string {
  return join(getConfigDir(home), "policy.json");
}

export async function loadConfig(path = getConfigPath()): Promise<DeckAgentConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return configSchema.parse(parsed);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error(`Invalid DeckAgent config at ${path}: ${formatError(error)}`);
  }
}

export async function saveConfig(config: DeckAgentConfig, path = getConfigPath()): Promise<void> {
  const valid = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
}

export async function loadPolicy(path = getPolicyPath()): Promise<DeckAgentPolicy | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return policySchema.parse(parsed);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error(`Invalid DeckAgent policy at ${path}: ${formatError(error)}`);
  }
}

export async function savePolicy(policy: DeckAgentPolicy, path = getPolicyPath()): Promise<void> {
  const valid = policySchema.parse(policy);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
}

export function getWorkerUrl(config: DeckAgentConfig): string {
  return config.worker_url;
}

export function getToken(config: DeckAgentConfig): string {
  return config.token;
}

export function getDeviceId(config: DeckAgentConfig): string {
  return config.device_id;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown validation error";
}
