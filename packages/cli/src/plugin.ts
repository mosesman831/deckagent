import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getConfigDir, getPolicyPath } from './configure.js';

const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

const BUILTIN_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'list_directory',
  'create_directory',
  'move_file',
  'get_file_info',
  'read_multiple_files',
  'execute_command',
  'execute_command_stream',
  'list_processes',
  'kill_process',
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_evaluate',
  'get_environment',
  'list_snapshots',
  'restore_snapshot'
]);

const ManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_PATTERN),
  description: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  require_confirmation: z.boolean().optional().default(true),
  integrity: z
    .object({
      sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/, 'sha256 must be 64 hex characters')
        .transform((value) => value.toLowerCase())
    })
    .strict()
    .optional()
});

type Manifest = z.infer<typeof ManifestSchema>;
type PluginIntegrityStatus = 'ok' | 'missing' | 'mismatch';

interface PluginListRow {
  name: string;
  version: string;
  description: string;
  directory: string;
  enabled: boolean;
  requireConfirmation: boolean;
  integrityStatus: PluginIntegrityStatus;
  error?: string;
}

interface RawPolicy {
  profile?: string;
  read_only?: boolean;
  allow_plugins?: boolean;
  require_plugin_integrity?: boolean;
}

function getPluginsRoot(): string {
  return path.join(getConfigDir(), 'plugins');
}

function readRawPolicy(): RawPolicy | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getPolicyPath(), 'utf-8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      profile: typeof record.profile === 'string' ? record.profile : undefined,
      read_only: typeof record.read_only === 'boolean' ? record.read_only : undefined,
      allow_plugins:
        typeof record.allow_plugins === 'boolean' ? record.allow_plugins : undefined,
      require_plugin_integrity:
        typeof record.require_plugin_integrity === 'boolean'
          ? record.require_plugin_integrity
          : undefined
    };
  } catch {
    return null;
  }
}

function effectiveAllowPlugins(policy: RawPolicy | null): boolean {
  const profile = policy?.profile ?? 'strict';
  if (policy?.read_only) return false;
  if (profile === 'strict' || profile === 'locked') return false;
  if (profile === 'dev') return policy?.allow_plugins ?? true;
  return false;
}

function effectiveRequirePluginIntegrity(policy: RawPolicy | null): boolean {
  if (typeof policy?.require_plugin_integrity === 'boolean') {
    return policy.require_plugin_integrity;
  }
  const profile = policy?.profile ?? 'strict';
  return profile === 'strict' || profile === 'locked';
}

export function discoverPlugins(
  root: string,
  allowPlugins: boolean,
  requirePluginIntegrity: boolean
): PluginListRow[] {
  if (!fs.existsSync(root)) return [];

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  return fs
    .readdirSync(rootReal, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry): PluginListRow => {
      const pluginDir = path.resolve(rootReal, entry.name);
      try {
        const pluginDirReal = fs.realpathSync(pluginDir);
        if (!isPathInsideOrEqual(pluginDirReal, rootReal)) {
          throw new Error('plugin directory resolves outside plugins root');
        }
        const manifestPath = path.resolve(pluginDirReal, 'plugin.json');
        const manifestReal = fs.realpathSync(manifestPath);
        if (!isPathInsideOrEqual(manifestReal, pluginDirReal)) {
          throw new Error('plugin.json resolves outside plugin directory');
        }
        const manifest = readManifest(manifestReal);
        const entryReal = resolvePluginEntry(rootReal, pluginDirReal, manifest);
        const integrityStatus = getPluginIntegrityStatus(manifest, entryReal);
        const collision = BUILTIN_TOOL_NAMES.has(manifest.name) || seen.has(manifest.name);
        const integrityError = integrityListError(integrityStatus, requirePluginIntegrity);
        seen.add(manifest.name);
        return {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          directory: pluginDirReal,
          enabled: allowPlugins && !collision && !integrityError,
          requireConfirmation: manifest.require_confirmation,
          integrityStatus,
          ...(collision || integrityError
            ? {
                error: [
                  collision ? 'tool name collides with another tool' : null,
                  integrityError
                ]
                  .filter((message): message is string => !!message)
                  .join('; ')
              }
            : {})
        };
      } catch (err) {
        return {
          name: entry.name,
          version: '',
          description: '',
          directory: pluginDir,
          enabled: false,
          requireConfirmation: true,
          integrityStatus: 'missing',
          error: err instanceof Error ? err.message : String(err)
        };
      }
    });
}

function readManifest(manifestPath: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch (err) {
    throw new Error(`invalid plugin.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid plugin manifest: ${result.error.message}`);
  }
  if (path.isAbsolute(result.data.entry) || result.data.entry.includes('\0')) {
    throw new Error('plugin entry must be a relative path');
  }
  return result.data;
}

export function hashFileSha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function hashPluginByName(
  name: string,
  root = getPluginsRoot()
): { name: string; entry: string; sha256: string } {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid plugin name: ${name}`);
  }
  if (!fs.existsSync(root)) {
    throw new Error(`Plugins root not found: ${root}`);
  }
  const rootReal = fs.realpathSync(root);
  for (const entry of fs.readdirSync(rootReal, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pluginDir = path.resolve(rootReal, entry.name);
    const pluginDirReal = fs.realpathSync(pluginDir);
    if (!isPathInsideOrEqual(pluginDirReal, rootReal)) continue;
    const manifestPath = path.resolve(pluginDirReal, 'plugin.json');
    const manifestReal = fs.realpathSync(manifestPath);
    if (!isPathInsideOrEqual(manifestReal, pluginDirReal)) continue;
    const manifest = readManifest(manifestReal);
    if (manifest.name !== name) continue;
    const entryReal = resolvePluginEntry(rootReal, pluginDirReal, manifest);
    return {
      name: manifest.name,
      entry: entryReal,
      sha256: hashFileSha256(entryReal)
    };
  }
  throw new Error(`Plugin not found: ${name}`);
}

function resolvePluginEntry(
  rootReal: string,
  pluginDirReal: string,
  manifest: Manifest
): string {
  const entryPath = path.resolve(pluginDirReal, manifest.entry);
  const entryReal = fs.realpathSync(entryPath);
  if (!isPathInsideOrEqual(entryReal, rootReal)) {
    throw new Error('plugin entry resolves outside plugins root');
  }
  return entryReal;
}

function getPluginIntegrityStatus(
  manifest: Manifest,
  entryReal: string
): PluginIntegrityStatus {
  const expected = manifest.integrity?.sha256;
  if (!expected) return 'missing';
  return hashFileSha256(entryReal) === expected ? 'ok' : 'mismatch';
}

function integrityListError(
  status: PluginIntegrityStatus,
  requirePluginIntegrity: boolean
): string | null {
  if (status === 'mismatch') return 'PLUGIN_INTEGRITY_MISMATCH';
  if (status === 'missing' && requirePluginIntegrity) return 'PLUGIN_INTEGRITY_MISSING';
  return null;
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedRoot = normalizeForCompare(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedCandidate.startsWith(prefix);
}

function normalizeForCompare(inputPath: string): string {
  let normalized = path.normalize(inputPath);
  if (path.sep === '\\') {
    normalized = normalized.replace(/\//g, '\\');
  } else {
    normalized = normalized.replace(/\\/g, '/');
  }
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  if (normalized.length > 1 && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function printPluginHelp(): void {
  console.log(`Usage:
  deckagent plugin list
  deckagent plugin hash <name>
`);
}

export async function runPluginCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printPluginHelp();
    return;
  }

  if (sub === 'hash') {
    const name = args[1];
    if (!name) {
      throw new Error('Usage: deckagent plugin hash <name>');
    }
    console.log(hashPluginByName(name).sha256);
    return;
  }

  if (sub !== 'list') {
    throw new Error(`Unknown plugin command: ${sub}. Use: list, hash <name>`);
  }

  const root = getPluginsRoot();
  const rawPolicy = readRawPolicy();
  const allowPlugins = effectiveAllowPlugins(rawPolicy);
  const requirePluginIntegrity = effectiveRequirePluginIntegrity(rawPolicy);
  const profile = rawPolicy?.profile ?? 'strict';
  const rows = discoverPlugins(root, allowPlugins, requirePluginIntegrity);

  console.log(`Plugins root: ${root}`);
  console.log(
    `Policy: plugins ${allowPlugins ? 'enabled' : 'disabled'} (profile=${profile}, require_plugin_integrity=${String(requirePluginIntegrity)})`
  );
  if (!allowPlugins) {
    console.log('Hint: use profile=dev with allow_plugins=true, then restart the daemon.');
  }
  if (rows.length === 0) {
    console.log(`No plugins found. Create ${path.join(root, 'example', 'plugin.json')}`);
    return;
  }

  for (const row of rows) {
    const status = row.enabled ? 'enabled' : 'disabled';
    const confirm = row.requireConfirmation ? 'confirmation' : 'no confirmation';
    const integrity = `integrity ${row.integrityStatus}`;
    const error = row.error ? ` (${row.error})` : '';
    console.log(
      `- ${row.name || path.basename(row.directory)} ${row.version} — ${status}, ${confirm}, ${integrity}${error}`
    );
    if (row.description) {
      console.log(`  ${row.description}`);
    }
    console.log(`  ${row.directory}`);
  }
}
