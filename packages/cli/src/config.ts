import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Config + policy management for the DeckAgent CLI.
 * Everything lives under ~/.deckagent (overridable via the `home` argument
 * for testing). No secrets or config values are read from environment vars.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getConfigDir(home: string = homedir()): string {
  return join(home, ".deckagent");
}

export function getConfigPath(home: string = homedir()): string {
  return join(getConfigDir(home), "config.json");
}

export function getPolicyPath(home: string = homedir()): string {
  return join(getConfigDir(home), "policy.json");
}

export function getLogsDir(home: string = homedir()): string {
  return join(getConfigDir(home), "logs");
}

export function getLogPath(home: string = homedir()): string {
  return join(getLogsDir(home), "deckagent.log");
}

export function getPidPath(home: string = homedir()): string {
  return join(getConfigDir(home), "daemon.pid");
}

export function getBinWrapperPath(home: string = homedir()): string {
  return join(getConfigDir(home), "bin", "deckagent-daemon");
}

/**
 * Resolve the monorepo root from this module's location.
 * Compiled layout: <repo>/packages/cli/dist/config.js -> up 3 == <repo>.
 */
export function getRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

export function getDaemonEntry(repoRoot: string = getRepoRoot()): string {
  return join(repoRoot, "packages", "desktop-daemon", "dist", "index.js");
}

export function getWorkerDir(repoRoot: string = getRepoRoot()): string {
  return join(repoRoot, "packages", "cloudflare-worker");
}

export function getWranglerConfigPath(repoRoot: string = getRepoRoot()): string {
  return join(getWorkerDir(repoRoot), "wrangler.jsonc");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  device_id: z.string().min(1),
  token: z.string().min(1),
  worker_url: z.string().url(),
  device_name: z.string().min(1),
  heartbeat_interval: z.number().int().positive().default(15),
  tool_timeout: z.number().int().positive().default(60),
  auto_connect: z.boolean().default(true),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Partial config used while setup is still assembling values. */
export const PartialConfigSchema = ConfigSchema.partial();
export type PartialConfig = z.infer<typeof PartialConfigSchema>;

export const PolicySchema = z.object({
  version: z.number().int().positive().default(1),
  allowed_directories: z.array(z.string()).default([]),
  blocked_commands: z.array(z.string()).default([]),
  require_confirmation: z.array(z.string()).default([]),
  read_only: z.boolean().default(false),
  allow_browser: z.boolean().default(true),
  allow_terminal: z.boolean().default(true),
  allow_computer_use: z.boolean().default(false),
  max_file_read_size: z.number().int().positive().default(10 * 1024 * 1024),
  max_command_timeout: z.number().int().positive().default(300),
});

export type Policy = z.infer<typeof PolicySchema>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultPolicy(home: string = homedir()): Policy {
  return PolicySchema.parse({
    version: 1,
    allowed_directories: [home],
    blocked_commands: [
      "rm -rf",
      "sudo",
      "mkfs",
      "dd if=",
      ":(){:|:&};:",
      "shutdown",
      "reboot",
      "> /dev/sda",
    ],
    require_confirmation: [],
    read_only: false,
    allow_browser: true,
    allow_terminal: true,
    allow_computer_use: false,
    max_file_read_size: 10 * 1024 * 1024,
    max_command_timeout: 300,
  });
}

// ---------------------------------------------------------------------------
// Identity generation
// ---------------------------------------------------------------------------

/** Random 256-bit token as 64 hex chars. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** UUID v4 device id. */
export function generateDeviceId(): string {
  return randomUUID();
}

/** 512-bit deploy secret as 64 hex chars (per SPEC: 64 hex chars). */
export function generateDeploySecret(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export function ensureConfigDir(home: string = homedir()): void {
  mkdirSync(getConfigDir(home), { recursive: true });
  mkdirSync(getLogsDir(home), { recursive: true });
}

export function configExists(home: string = homedir()): boolean {
  return existsSync(getConfigPath(home));
}

/**
 * Load and validate the full config. Returns null if the file does not exist.
 * Throws a human-readable error if the file is present but invalid.
 */
export function loadConfig(home: string = homedir()): Config | null {
  const path = getConfigPath(home);
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config at ${path}: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

/** Load whatever is present without requiring a complete config. */
export function loadPartialConfig(home: string = homedir()): PartialConfig {
  const path = getConfigPath(home);
  if (!existsSync(path)) return {};
  const parsed = readJson(path);
  const result = PartialConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config at ${path}: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function saveConfig(config: Config, home: string = homedir()): void {
  ensureConfigDir(home);
  const validated = ConfigSchema.parse(config);
  writeJson(getConfigPath(home), validated);
}

export function loadPolicy(home: string = homedir()): Policy | null {
  const path = getPolicyPath(home);
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid policy at ${path}: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function savePolicy(policy: Policy, home: string = homedir()): void {
  ensureConfigDir(home);
  const validated = PolicySchema.parse(policy);
  writeJson(getPolicyPath(home), validated);
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

export function getWorkerUrl(home: string = homedir()): string {
  const config = loadConfig(home);
  if (!config) throw new Error("No config found. Run `deckagent setup` first.");
  return config.worker_url;
}

export function getToken(home: string = homedir()): string {
  const config = loadConfig(home);
  if (!config) throw new Error("No config found. Run `deckagent setup` first.");
  return config.token;
}

export function getDeviceId(home: string = homedir()): string {
  const config = loadConfig(home);
  if (!config) throw new Error("No config found. Run `deckagent setup` first.");
  return config.device_id;
}

// ---------------------------------------------------------------------------
// Interactive prompts (readline)
// ---------------------------------------------------------------------------

export async function prompt(
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

export async function promptYesNo(
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await prompt(`${question} (${hint})`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON at ${path}: ${(err as Error).message}`,
    );
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.join(".") || "(root)";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}
