import { promises as fs } from "node:fs";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve as resolvePath,
  sep,
  normalize,
} from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolRegistry } from "@deckagent/mcp-server";
import type { Policy } from "./policy.js";
import type { Logger } from "./logger.js";
import { ALL_KNOWN_TOOLS } from "./capabilities.js";

export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export interface PluginToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LoadedPlugin {
  name: string;
  description: string;
  version: string;
  directory: string;
  entry: string;
  require_confirmation: boolean;
  inputSchema: Record<string, unknown>;
  integrity_status: PluginIntegrityStatus;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  requireConfirmationTools: string[];
  toolCatalog: PluginToolCatalogEntry[];
}

export interface PluginListEntry {
  name: string;
  description: string;
  version: string;
  directory: string;
  enabled: boolean;
  require_confirmation: boolean;
  integrity_status: PluginIntegrityStatus;
  error?: string;
}

export type PluginIntegrityStatus = "ok" | "missing" | "mismatch";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface JsonSchema {
  [key: string]: unknown;
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: JsonValue[];
  const?: JsonValue;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

interface PluginToolResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const JsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.union([z.string(), z.array(z.string())]).optional(),
      description: z.string().optional(),
      properties: z.record(JsonSchemaSchema).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z
        .union([z.boolean(), JsonSchemaSchema])
        .optional(),
      items: JsonSchemaSchema.optional(),
      enum: z.array(JsonValueSchema).optional(),
      const: JsonValueSchema.optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
);

const PluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_PATTERN),
  description: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().min(1),
  inputSchema: JsonSchemaSchema.refine(
    (schema) => schemaAllowsType(schema, "object"),
    "inputSchema must be a JSON Schema object schema",
  ),
  require_confirmation: z.boolean().optional().default(true),
  integrity: z
    .object({
      sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/, "sha256 must be 64 hex characters")
        .transform((value) => value.toLowerCase()),
    })
    .strict()
    .optional(),
});

const ToolContentSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
  }),
]);

const PluginResponseSchema: z.ZodType<PluginToolResponse> = z.object({
  content: z.array(ToolContentSchema),
  isError: z.boolean().optional(),
});

type PluginManifest = z.infer<typeof PluginManifestSchema>;

const PluginChildMessageSchema = z.union([
  z.object({ type: z.literal("result"), result: PluginResponseSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

type PluginChildMessage = z.infer<typeof PluginChildMessageSchema>;

const PLUGIN_CHILD_PATH = join(dirname(fileURLToPath(import.meta.url)), "plugin-child.js");

export function getPluginsRoot(): string {
  return join(homedir(), ".deckagent", "plugins");
}

export async function loadPlugins(options: {
  registry: ToolRegistry;
  policy: Policy;
  logger: Pick<Logger, "info" | "warn">;
  pluginsRoot?: string;
}): Promise<PluginLoadResult> {
  const result: PluginLoadResult = {
    plugins: [],
    requireConfirmationTools: [],
    toolCatalog: [],
  };

  if (!options.policy.allow_plugins) {
    options.logger.info(
      "Custom tool plugins disabled by policy (allow_plugins=false)",
    );
    return result;
  }

  const root = options.pluginsRoot ?? getPluginsRoot();
  const rootReal = await realpathIfExists(root);
  if (!rootReal) {
    return result;
  }

  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = await fs.readdir(rootReal, { withFileTypes: true });
  } catch (err) {
    options.logger.warn(
      `Could not read plugins directory '${root}': ${humanError(err)}`,
    );
    return result;
  }

  const loadedNames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const pluginDir = resolvePath(rootReal, entry.name);
    const loaded = await loadOnePlugin({
      registry: options.registry,
      logger: options.logger,
      policy: options.policy,
      rootReal,
      pluginDir,
      loadedNames,
    });

    if (!loaded) continue;
    loadedNames.add(loaded.name);
    result.plugins.push(loaded);
    result.toolCatalog.push({
      name: loaded.name,
      description: loaded.description,
      inputSchema: loaded.inputSchema,
    });
    if (loaded.require_confirmation) {
      result.requireConfirmationTools.push(loaded.name);
    }
  }

  if (result.plugins.length > 0) {
    options.logger.info(`Loaded ${result.plugins.length} custom tool plugin(s)`);
  }

  return result;
}

export async function listPlugins(options?: {
  policy?: Pick<Policy, "allow_plugins" | "require_plugin_integrity">;
  pluginsRoot?: string;
}): Promise<PluginListEntry[]> {
  const root = options?.pluginsRoot ?? getPluginsRoot();
  const rootReal = await realpathIfExists(root);
  if (!rootReal) return [];

  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = await fs.readdir(rootReal, { withFileTypes: true });
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const output: PluginListEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const pluginDir = resolvePath(rootReal, entry.name);
    const manifestPath = resolvePath(pluginDir, "plugin.json");
    try {
      const pluginDirReal = await fs.realpath(pluginDir);
      if (!isPathInsideOrEqual(pluginDirReal, rootReal)) {
        throw new Error("plugin directory resolves outside plugins root");
      }
      const manifestReal = await fs.realpath(manifestPath);
      if (!isPathInsideOrEqual(manifestReal, pluginDirReal)) {
        throw new Error("plugin.json resolves outside plugin directory");
      }
      const manifest = await readManifest(manifestReal);
      const entryPath = resolvePath(pluginDirReal, manifest.entry);
      const entryReal = await fs.realpath(entryPath);
      if (!isPathInsideOrEqual(entryReal, rootReal)) {
        throw new Error("plugin entry resolves outside plugins root");
      }
      const integrity_status = await getPluginIntegrityStatus(
        manifest,
        entryReal,
      );
      const collision =
        ALL_KNOWN_TOOLS.includes(manifest.name) || seen.has(manifest.name);
      const integrityError = integrityListError(
        integrity_status,
        !!options?.policy?.require_plugin_integrity,
      );
      seen.add(manifest.name);
      output.push({
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        directory: pluginDirReal,
        enabled:
          !!options?.policy?.allow_plugins && !collision && !integrityError,
        require_confirmation: manifest.require_confirmation,
        integrity_status,
        ...(collision || integrityError
          ? {
              error: [
                collision ? "tool name collides with another tool" : null,
                integrityError,
              ]
                .filter((message): message is string => !!message)
                .join("; "),
            }
          : {}),
      });
    } catch (err) {
      output.push({
        name: basename(pluginDir),
        description: "",
        version: "",
        directory: pluginDir,
        enabled: false,
        require_confirmation: true,
        integrity_status: "missing",
        error: humanError(err),
      });
    }
  }
  return output;
}

async function loadOnePlugin(options: {
  registry: ToolRegistry;
  logger: Pick<Logger, "info" | "warn">;
  policy: Policy;
  rootReal: string;
  pluginDir: string;
  loadedNames: Set<string>;
}): Promise<LoadedPlugin | null> {
  try {
    const pluginDirReal = await fs.realpath(options.pluginDir);
    if (!isPathInsideOrEqual(pluginDirReal, options.rootReal)) {
      throw new Error("plugin directory resolves outside plugins root");
    }

    const manifestPath = resolvePath(pluginDirReal, "plugin.json");
    const manifestReal = await fs.realpath(manifestPath);
    if (!isPathInsideOrEqual(manifestReal, pluginDirReal)) {
      throw new Error("plugin.json resolves outside plugin directory");
    }

    const manifest = await readManifest(manifestReal);
    if (ALL_KNOWN_TOOLS.includes(manifest.name)) {
      throw new Error(`plugin tool '${manifest.name}' collides with a builtin tool`);
    }
    if (options.registry.get(manifest.name) || options.loadedNames.has(manifest.name)) {
      throw new Error(`plugin tool '${manifest.name}' collides with another tool`);
    }

    const entryPath = resolvePath(pluginDirReal, manifest.entry);
    const entryReal = await fs.realpath(entryPath);
    if (!isPathInsideOrEqual(entryReal, options.rootReal)) {
      throw new Error("plugin entry resolves outside plugins root");
    }

    const integrity_status = await verifyPluginIntegrity({
      manifest,
      entry: entryReal,
      requireIntegrity: options.policy.require_plugin_integrity,
    });

    const inputValidator = createZodSchemaFromJsonSchema(manifest.inputSchema);
    const timeoutMs = options.policy.max_command_timeout * 1000;

    options.registry.register({
      name: manifest.name,
      description: manifest.description,
      inputSchema: inputValidator,
      handler: async (args) => {
        options.logger.info(`Executing plugin:${manifest.name}`);
        const jsonArgs = JsonValueSchema.safeParse(args);
        if (!jsonArgs.success) {
          return {
            content: [
              {
                type: "text",
                text: `Plugin '${manifest.name}' arguments must be JSON-serializable: ${jsonArgs.error.message}`,
              },
            ],
            isError: true,
          };
        }
        try {
          return await runPluginInChild({
            name: manifest.name,
            entry: entryReal,
            args: jsonArgs.data,
            timeoutMs,
          });
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Plugin '${manifest.name}' failed: ${humanError(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    });

    options.logger.info(`Loaded plugin '${manifest.name}' from ${pluginDirReal}`);
    return {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      directory: pluginDirReal,
      entry: entryReal,
      require_confirmation: manifest.require_confirmation,
      inputSchema: manifest.inputSchema,
      integrity_status,
    };
  } catch (err) {
    options.logger.warn(
      `Skipping plugin '${basename(options.pluginDir)}': ${humanError(err)}`,
    );
    return null;
  }
}

export async function hashFileSha256(path: string): Promise<string> {
  const contents = await fs.readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

async function verifyPluginIntegrity(options: {
  manifest: PluginManifest;
  entry: string;
  requireIntegrity: boolean;
}): Promise<PluginIntegrityStatus> {
  const status = await getPluginIntegrityStatus(options.manifest, options.entry);
  if (status === "mismatch") {
    throw new Error(
      `[PLUGIN_INTEGRITY_MISMATCH] Plugin '${options.manifest.name}' entry ` +
        "hash does not match plugin.json integrity.sha256",
    );
  }
  if (status === "missing" && options.requireIntegrity) {
    throw new Error(
      `[PLUGIN_INTEGRITY_MISSING] Plugin '${options.manifest.name}' is missing ` +
        "plugin.json integrity.sha256 required by policy",
    );
  }
  return status;
}

async function getPluginIntegrityStatus(
  manifest: PluginManifest,
  entry: string,
): Promise<PluginIntegrityStatus> {
  const expected = manifest.integrity?.sha256;
  if (!expected) return "missing";
  const actual = await hashFileSha256(entry);
  return actual === expected ? "ok" : "mismatch";
}

function integrityListError(
  status: PluginIntegrityStatus,
  requireIntegrity: boolean,
): string | null {
  if (status === "mismatch") {
    return "PLUGIN_INTEGRITY_MISMATCH";
  }
  if (status === "missing" && requireIntegrity) {
    return "PLUGIN_INTEGRITY_MISSING";
  }
  return null;
}

async function runPluginInChild(options: {
  name: string;
  entry: string;
  args: JsonValue;
  timeoutMs: number;
}): Promise<PluginToolResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(PLUGIN_CHILD_PATH, [], {
      env: strippedPluginEnv(),
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `timed out after ${Math.round(options.timeoutMs / 1000)}s`,
        ),
      );
    }, options.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    child.once("message", (raw: unknown) => {
      const parsed = PluginChildMessageSchema.safeParse(raw);
      if (!parsed.success) {
        finish(() =>
          reject(
            new Error(`invalid child response: ${parsed.error.message}`),
          ),
        );
        child.kill("SIGKILL");
        return;
      }

      const message: PluginChildMessage = parsed.data;
      if (message.type === "error") {
        finish(() => reject(new Error(message.message)));
        return;
      }
      finish(() => resolve(message.result));
    });

    child.once("error", (err) => {
      finish(() => reject(new Error(`child process error: ${humanError(err)}`)));
    });

    child.once("exit", (code, signal) => {
      finish(() =>
        reject(
          new Error(
            `child process exited before result (code=${String(code)}, signal=${String(signal)})`,
          ),
        ),
      );
    });

    child.send(
      {
        type: "run",
        entry: options.entry,
        args: options.args,
      },
      (err) => {
        if (err) {
          finish(() =>
            reject(new Error(`failed to send run message: ${humanError(err)}`)),
          );
        }
      },
    );
  });
}

function strippedPluginEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR"] as const) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

async function readManifest(path: string): Promise<PluginManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf-8"));
  } catch (err) {
    throw new Error(`invalid plugin.json: ${humanError(err)}`);
  }

  const manifest = PluginManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    throw new Error(`invalid plugin manifest: ${manifest.error.message}`);
  }

  if (manifest.data.entry.includes("\0")) {
    throw new Error("plugin entry contains an invalid path character");
  }

  return manifest.data;
}

function createZodSchemaFromJsonSchema(
  schema: JsonSchema,
): z.ZodType<unknown> {
  return z.unknown().superRefine((value, ctx) => {
    for (const issue of validateJsonSchema(schema, value, "args")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    }
  });
}

function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  path: string,
): string[] {
  const issues: string[] = [];

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    issues.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((entry) => jsonEqual(value, entry))) {
    issues.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (!matchesSchemaType(schema, value)) {
    issues.push(`${path} must be ${formatSchemaType(schema.type)}`);
    return issues;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(`${path} must have at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push(`${path} must have at most ${schema.maxLength} characters`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          issues.push(`${path} must match pattern ${schema.pattern}`);
        }
      } catch {
        issues.push(`${path} has an invalid schema pattern`);
      }
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(`${path} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(`${path} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(`${path} must have at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push(`${path} must have at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(
          ...validateJsonSchema(schema.items!, item, `${path}[${index}]`),
        );
      });
    }
  }

  if (isPlainRecord(value)) {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        issues.push(`${path}.${key} is required`);
      }
    }

    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        issues.push(...validateJsonSchema(childSchema, childValue, `${path}.${key}`));
        continue;
      }
      if (schema.additionalProperties === false) {
        issues.push(`${path}.${key} is not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties !== "boolean"
      ) {
        issues.push(
          ...validateJsonSchema(
            schema.additionalProperties,
            childValue,
            `${path}.${key}`,
          ),
        );
      }
    }
  }

  return issues;
}

function schemaAllowsType(schema: JsonSchema, type: string): boolean {
  if (schema.type === undefined) return type === "object";
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function matchesSchemaType(schema: JsonSchema, value: unknown): boolean {
  if (schema.type === undefined) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some((type) => valueMatchesType(value, type));
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatSchemaType(type: JsonSchema["type"]): string {
  if (type === undefined) return "a JSON value";
  return Array.isArray(type) ? type.join(" or ") : type;
}

function jsonEqual(left: unknown, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedRoot = normalizeForCompare(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep)
    ? normalizedRoot
    : normalizedRoot + sep;
  return normalizedCandidate.startsWith(prefix);
}

function normalizeForCompare(inputPath: string): string {
  let normalized = normalize(inputPath);
  if (sep === "\\") {
    normalized = normalized.replace(/\//g, "\\");
  } else {
    normalized = normalized.replace(/\\/g, "/");
  }
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
