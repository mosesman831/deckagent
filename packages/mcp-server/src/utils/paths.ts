import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ToolError } from '../error.js';

/** Expand a leading `~` (or `~/...`) to the given home directory. */
export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homeDir, p.slice(2));
  }
  return p;
}

/** Format a byte count as a human-readable size string. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 100) / 100;
  return `${rounded} ${units[unit]}`;
}

/**
 * Return true if `candidate` is inside one of `allowedDirectories`. An empty
 * list (or a list containing the filesystem root) means "no restriction".
 * Comparison is path-separator aware to avoid `/foo` matching `/foobar`.
 */
export function isPathAllowed(candidate: string, allowedDirectories?: string[]): boolean {
  if (!allowedDirectories || allowedDirectories.length === 0) return true;
  const resolved = path.resolve(candidate);
  const root = path.parse(resolved).root;
  return allowedDirectories.some((dir) => {
    const allowed = path.resolve(dir);
    if (allowed === root) return true; // root allows everything
    if (resolved === allowed) return true;
    const withSep = allowed.endsWith(path.sep) ? allowed : allowed + path.sep;
    return resolved.startsWith(withSep);
  });
}

/**
 * Resolve and validate a requested path. Expands `~`, makes it absolute,
 * resolves symlinks (falling back to the deepest existing ancestor for paths
 * that don't exist yet), and enforces `allowedDirectories`.
 */
export async function validatePath(
  requestedPath: string,
  allowedDirectories?: string[],
  homeDir: string = os.homedir(),
  allowNonexistent = false,
): Promise<string> {
  const expanded = expandHome(requestedPath, homeDir);
  const absolute = path.resolve(expanded);

  let resolved: string;
  try {
    resolved = await fs.realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!allowNonexistent) {
        throw new ToolError('FILE_NOT_FOUND', `File or directory not found: ${absolute}`);
      }
      resolved = await resolveDeepestAncestor(absolute);
    } else {
      throw new ToolError('INTERNAL_ERROR', `Failed to resolve path ${absolute}: ${(err as Error).message}`);
    }
  }

  if (!isPathAllowed(resolved, allowedDirectories)) {
    throw new ToolError(
      'POLICY_BLOCKED',
      `Access denied: ${resolved} is outside the allowed directories.`,
      { allowedDirectories },
    );
  }
  return resolved;
}

/**
 * For a nonexistent path, walk up until an existing ancestor is found, resolve
 * its real path (symlinks), then re-join the remaining nonexistent segments.
 */
async function resolveDeepestAncestor(absolute: string): Promise<string> {
  const segments: string[] = [];
  let current = absolute;
  // Walk up toward the root, collecting missing tail segments.
  // Guard against infinite loops with the parent check.
  for (;;) {
    const parent = path.dirname(current);
    segments.unshift(path.basename(current));
    try {
      const realParent = await fs.realpath(parent);
      return path.join(realParent, ...segments);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (parent === current) {
        // Reached the root and still nothing exists; return the absolute path.
        return absolute;
      }
      current = parent;
    }
  }
}
