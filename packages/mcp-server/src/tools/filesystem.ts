import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ToolError, toToolError } from '../error.js';
import type { ToolContext, ToolDefinition, ToolResponse } from '../types.js';
import { validatePath, formatFileSize } from '../utils/paths.js';
import { replaceBlock } from '../utils/fuzzy.js';
import {
  ReadFileArgsSchema,
  WriteFileArgsSchema,
  EditFileArgsSchema,
  SearchFilesArgsSchema,
  ListDirectoryArgsSchema,
  CreateDirectoryArgsSchema,
  MoveFileArgsSchema,
  GetFileInfoArgsSchema,
  ReadMultipleFilesArgsSchema,
} from '../schemas.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILE_READ_SIZE = 10 * 1024 * 1024; // 10MB

function textResponse(text: string, isError = false): ToolResponse {
  return { content: [{ type: 'text', text }], isError: isError || undefined };
}

/** True if the buffer looks binary (>30% null bytes in the sampled region). */
function isBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let nulls = 0;
  for (const byte of sample) {
    if (byte === 0) nulls += 1;
  }
  return nulls / sample.length > 0.3;
}

async function readFileContent(
  requestedPath: string,
  offset: number,
  limit: number,
  context: ToolContext,
): Promise<string> {
  const resolved = await validatePath(requestedPath, context.allowedDirectories, context.homeDir);
  const stats = await fs.stat(resolved);

  if (stats.isDirectory()) {
    return listDirectoryText(resolved);
  }

  const maxSize = context.maxFileReadSize ?? DEFAULT_MAX_FILE_READ_SIZE;
  if (stats.size > maxSize) {
    throw new ToolError(
      'FILE_TOO_LARGE',
      `File is ${formatFileSize(stats.size)}, which exceeds the maximum readable size of ${formatFileSize(maxSize)}.`,
      { size: stats.size, maxSize },
    );
  }

  const buffer = await fs.readFile(resolved);
  if (isBinary(buffer)) {
    throw new ToolError('INVALID_ARGUMENTS', `File appears to be binary: ${resolved}`);
  }

  const lines = buffer.toString('utf8').split('\n');
  const start = offset - 1; // offset is 1-indexed
  const slice = lines.slice(start, start + limit);
  const header = `${resolved} (lines ${start + 1}-${start + slice.length} of ${lines.length})`;
  return `${header}\n${slice.join('\n')}`;
}

async function listDirectoryText(resolved: string): Promise<string> {
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const lines: string[] = [`Directory listing of ${resolved}:`];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(resolved, entry.name);
    let size = '';
    let modified = '';
    try {
      const st = await fs.stat(full);
      size = entry.isDirectory() ? '' : ` ${formatFileSize(st.size)}`;
      modified = ` ${st.mtime.toISOString()}`;
    } catch {
      // Ignore entries we cannot stat (e.g. broken symlinks).
    }
    const type = entry.isDirectory() ? '[DIR] ' : '[FILE]';
    lines.push(`${type} ${entry.name}${size}${modified}`);
  }
  return lines.join('\n');
}

async function atomicWrite(resolved: string, content: string): Promise<void> {
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.deckagent-${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, resolved);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read the complete contents of a file from the local filesystem. Use for any text-based file. For large files, specify offset and limit. If the path is a directory, its contents are listed.',
    inputSchema: ReadFileArgsSchema,
    handler: async (args, context) => {
      try {
        const text = await readFileContent(args.path, args.offset, args.limit, context);
        return textResponse(text);
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file, creating it if it does not exist. OVERWRITES existing content. Use edit_file for surgical changes.',
    inputSchema: WriteFileArgsSchema,
    handler: async (args, context) => {
      try {
        const resolved = await validatePath(args.path, context.allowedDirectories, context.homeDir, true);
        await atomicWrite(resolved, args.content);
        const bytes = Buffer.byteLength(args.content, 'utf8');
        return textResponse(`Written ${bytes} bytes to ${resolved}`);
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'edit_file',
    description:
      'Surgical find-and-replace edit on a file. Replaces an exact string match, falling back to whitespace-tolerant fuzzy matching. Set replace_all to replace every occurrence.',
    inputSchema: EditFileArgsSchema,
    handler: async (args, context) => {
      try {
        const resolved = await validatePath(args.path, context.allowedDirectories, context.homeDir);
        const original = await fs.readFile(resolved, 'utf8');
        const result = replaceBlock(original, args.old_string, args.new_string, args.replace_all);
        await atomicWrite(resolved, result.content);
        const mode = result.fuzzy ? ' (fuzzy match)' : '';
        const diff = `Diff:\n- ${args.old_string.split('\n').join('\n- ')}\n+ ${args.new_string.split('\n').join('\n+ ')}`;
        return textResponse(
          `Made ${result.replacements} replacement(s) in ${resolved}${mode}.\n${diff}`,
        );
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents using ripgrep (falls back to a pure-Node scan). Fast regex search across a directory tree.',
    inputSchema: SearchFilesArgsSchema,
    handler: async (args, context) => {
      try {
        const resolved = await validatePath(args.path, context.allowedDirectories, context.homeDir);
        const results = await searchFiles(resolved, args.pattern, args.file_glob, args.max_results);
        if (results.length === 0) {
          return textResponse(`No matches found for /${args.pattern}/ in ${resolved}`);
        }
        return textResponse(results.join('\n'));
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path with metadata (type, size, modified time).',
    inputSchema: ListDirectoryArgsSchema,
    handler: async (args, context) => {
      try {
        const resolved = await validatePath(args.path, context.allowedDirectories, context.homeDir);
        const stats = await fs.stat(resolved);
        if (!stats.isDirectory()) {
          throw new ToolError('INVALID_ARGUMENTS', `Not a directory: ${resolved}`);
        }
        return textResponse(await listDirectoryText(resolved));
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'create_directory',
    description: 'Create a directory and all parent directories if they do not exist.',
    inputSchema: CreateDirectoryArgsSchema,
    handler: async (args, context) => {
      try {
        const resolved = await validatePath(args.path, context.allowedDirectories, context.homeDir, true);
        await fs.mkdir(resolved, { recursive: true });
        return textResponse(`Created directory ${resolved}`);
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory.',
    inputSchema: MoveFileArgsSchema,
    handler: async (args, context) => {
      try {
        const source = await validatePath(args.source, context.allowedDirectories, context.homeDir);
        const destination = await validatePath(args.destination, context.allowedDirectories, context.homeDir, true);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try {
          await fs.rename(source, destination);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            await fs.cp(source, destination, { recursive: true });
            await fs.rm(source, { recursive: true, force: true });
          } else {
            throw err;
          }
        }
        return textResponse(`Moved ${source} -> ${destination}`);
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'get_file_info',
    description: 'Get metadata about a file or directory: size, timestamps, type, and permissions.',
    inputSchema: GetFileInfoArgsSchema,
    handler: async (args, context) => {
      try {
        const resolved = await validatePath(args.path, context.allowedDirectories, context.homeDir);
        const st = await fs.stat(resolved);
        const info = {
          path: resolved,
          size: st.size,
          size_human: formatFileSize(st.size),
          created: st.birthtime.toISOString(),
          modified: st.mtime.toISOString(),
          accessed: st.atime.toISOString(),
          isDirectory: st.isDirectory(),
          isFile: st.isFile(),
          isSymbolicLink: st.isSymbolicLink(),
          permissions: (st.mode & 0o777).toString(8),
        };
        return textResponse(JSON.stringify(info, null, 2));
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'read_multiple_files',
    description: 'Read several files at once. Returns their contents separated by --- markers.',
    inputSchema: ReadMultipleFilesArgsSchema,
    handler: async (args, context) => {
      const sections: string[] = [];
      for (const p of args.paths) {
        try {
          const text = await readFileContent(p, 1, 500, context);
          sections.push(`--- ${p} ---\n${text}`);
        } catch (err) {
          // Surface the first failure as a ToolError per spec.
          throw toToolError(err);
        }
      }
      return textResponse(sections.join('\n\n'));
    },
  },
];

/** Run ripgrep; on failure (not installed) fall back to a recursive Node scan. */
async function searchFiles(
  dir: string,
  pattern: string,
  fileGlob: string | undefined,
  maxResults: number,
): Promise<string[]> {
  const rgArgs = ['-n', '--color', 'never', '--max-count', '10'];
  if (fileGlob) rgArgs.push('-g', fileGlob);
  rgArgs.push('--', pattern, dir);
  try {
    const { stdout } = await execFileAsync('rg', rgArgs, { maxBuffer: 10 * 1024 * 1024 });
    return stdout.split('\n').filter((l) => l.trim().length > 0).slice(0, maxResults);
  } catch (err) {
    const e = err as { stdout?: string; code?: number | string };
    // rg exits 1 when there are no matches — that is not an error for us.
    if (e.code === 1 && typeof e.stdout === 'string') {
      return e.stdout.split('\n').filter((l) => l.trim().length > 0).slice(0, maxResults);
    }
    if (e.code === 'ENOENT') {
      return nodeScan(dir, pattern, fileGlob, maxResults);
    }
    if (typeof e.stdout === 'string' && e.stdout.length > 0) {
      return e.stdout.split('\n').filter((l) => l.trim().length > 0).slice(0, maxResults);
    }
    throw err;
  }
}

/** Convert a simple glob (`*.ts`, `foo?.js`) into a RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function nodeScan(
  dir: string,
  pattern: string,
  fileGlob: string | undefined,
  maxResults: number,
): Promise<string[]> {
  const regex = new RegExp(pattern);
  const globRe = fileGlob ? globToRegExp(fileGlob) : undefined;
  const results: string[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

  async function walk(current: string): Promise<void> {
    if (results.length >= maxResults) return;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (globRe && !globRe.test(entry.name)) continue;
        let content: string;
        try {
          const buf = await fs.readFile(full);
          if (isBinary(buf)) continue;
          content = buf.toString('utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) return;
          if (regex.test(lines[i])) {
            results.push(`${full}:${i + 1}:${lines[i]}`);
          }
        }
      }
    }
  }

  await walk(dir);
  return results.slice(0, maxResults);
}
