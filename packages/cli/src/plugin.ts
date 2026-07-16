import fs from 'node:fs';
import path from 'node:path';
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
  require_confirmation: z.boolean().optional().default(true)
});

type Manifest = z.infer<typeof ManifestSchema>;

interface PluginListRow {
  name: string;
  version: string;
  description: string;
  directory: string;
  enabled: boolean;
  requireConfirmation: boolean;
  error?: string;
}

interface RawPolicy {
  profile?: string;
  read_only?: boolean;
  allow_plugins?: boolean;
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
        typeof record.allow_plugins === 'boolean' ? record.allow_plugins : undefined
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

function discoverPlugins(root: string, allowPlugins: boolean): PluginListRow[] {
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
        const collision = BUILTIN_TOOL_NAMES.has(manifest.name) || seen.has(manifest.name);
        seen.add(manifest.name);
        return {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          directory: pluginDirReal,
          enabled: allowPlugins && !collision,
          requireConfirmation: manifest.require_confirmation,
          ...(collision ? { error: 'tool name collides with another tool' } : {})
        };
      } catch (err) {
        return {
          name: entry.name,
          version: '',
          description: '',
          directory: pluginDir,
          enabled: false,
          requireConfirmation: true,
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
`);
}

export async function runPluginCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printPluginHelp();
    return;
  }

  if (sub !== 'list') {
    throw new Error(`Unknown plugin command: ${sub}. Use: list`);
  }

  const root = getPluginsRoot();
  const rawPolicy = readRawPolicy();
  const allowPlugins = effectiveAllowPlugins(rawPolicy);
  const profile = rawPolicy?.profile ?? 'strict';
  const rows = discoverPlugins(root, allowPlugins);

  console.log(`Plugins root: ${root}`);
  console.log(
    `Policy: plugins ${allowPlugins ? 'enabled' : 'disabled'} (profile=${profile})`
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
    const error = row.error ? ` (${row.error})` : '';
    console.log(
      `- ${row.name || path.basename(row.directory)} ${row.version} — ${status}, ${confirm}${error}`
    );
    if (row.description) {
      console.log(`  ${row.description}`);
    }
    console.log(`  ${row.directory}`);
  }
}
