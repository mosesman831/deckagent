import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const SecretEntrySchema = z.object({
  value: z.string(),
  created_at: z.string(),
});

const SecretsFileSchema = z.object({
  version: z.number().int().default(1),
  secrets: z.record(SecretEntrySchema).default({}),
});

type SecretsFile = z.infer<typeof SecretsFileSchema>;

/** Test override for secrets.json path. */
let secretsPathOverride: string | null = null;

export function getSecretsPath(): string {
  if (secretsPathOverride) return secretsPathOverride;
  return join(homedir(), ".deckagent", "secrets.json");
}

/** Test helper — point vault at a temp file. Pass null to reset. */
export function setSecretsPathForTest(path: string | null): void {
  secretsPathOverride = path;
}

function emptyVault(): SecretsFile {
  return { version: 1, secrets: {} };
}

function readVault(path = getSecretsPath()): SecretsFile {
  if (!existsSync(path)) {
    return emptyVault();
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read secrets file: ${path} (${humanError(err)})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Secrets file contains invalid JSON: ${path}`);
  }

  const result = SecretsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid secrets file: ${result.error.message}`);
  }
  return result.data;
}

function writeVault(data: SecretsFile, path = getSecretsPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const validated = SecretsFileSchema.parse(data);
  try {
    writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", {
      mode: 0o600,
    });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort on platforms that ignore mode
    }
  } catch (err) {
    throw new Error(
      `Failed to write secrets file: ${path} (${humanError(err)})`,
    );
  }
}

/** List secret names only (never values). */
export function listSecretNames(): string[] {
  const vault = readVault();
  return Object.keys(vault.secrets).sort();
}

/**
 * Resolve secret values by name. Missing names are omitted.
 * Never log the returned values.
 */
export function getSecrets(names: string[]): Record<string, string> {
  if (names.length === 0) return {};
  const vault = readVault();
  const out: Record<string, string> = {};
  for (const name of names) {
    const entry = vault.secrets[name];
    if (entry) {
      out[name] = entry.value;
    }
  }
  return out;
}

export function setSecret(name: string, value: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Secret name must not be empty");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(
      `Invalid secret name '${trimmed}': use letters, digits, and underscores (must start with letter or _)`,
    );
  }

  const vault = readVault();
  const existing = vault.secrets[trimmed];
  vault.secrets[trimmed] = {
    value,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  writeVault(vault);
}

export function deleteSecret(name: string): boolean {
  const vault = readVault();
  if (!(name in vault.secrets)) {
    return false;
  }
  delete vault.secrets[name];
  writeVault(vault);
  return true;
}

/**
 * Merge selected vault secrets into execute_command args.env.
 * Vault values are applied after user-provided env (vault wins for those keys).
 * Strips `use_secrets` from the returned args (keep original for audit).
 */
export function applySecretInjection(
  args: Record<string, unknown>,
  allowSecretInjection: boolean,
): { args: Record<string, unknown>; injected: string[] } {
  const useSecrets = Array.isArray(args.use_secrets)
    ? args.use_secrets.filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];

  const next: Record<string, unknown> = { ...args };
  delete next.use_secrets;

  if (useSecrets.length === 0 || !allowSecretInjection) {
    return { args: next, injected: [] };
  }

  const vaultSelected = getSecrets(useSecrets);
  const injected = Object.keys(vaultSelected);
  if (injected.length === 0) {
    return { args: next, injected: [] };
  }

  const userEnv =
    next.env !== null &&
    typeof next.env === "object" &&
    !Array.isArray(next.env)
      ? { ...(next.env as Record<string, string>) }
      : {};

  // Vault applied after user env → vault wins for selected keys.
  next.env = { ...userEnv, ...vaultSelected };
  return { args: next, injected };
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
