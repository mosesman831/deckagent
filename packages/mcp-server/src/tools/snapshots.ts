import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import zlib from "zlib";
import { promisify } from "util";
import {
  ListSnapshotsArgsSchema,
  RestoreSnapshotArgsSchema,
  type ListSnapshotsArgs,
  type RestoreSnapshotArgs,
  type ToolResponse,
} from "../schemas.js";
import { getWorkspaceContext, resolveToolPath } from "../workspace-context.js";

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const MAX_SNAPSHOTS_DEFAULT = 50;
const MAX_AGE_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

let maxSnapshots = MAX_SNAPSHOTS_DEFAULT;
let maxAgeMs = MAX_AGE_MS_DEFAULT;

let snapshotsDir = path.join(os.homedir(), ".deckagent", "snapshots");

export function setSnapshotsDir(dir: string): void {
  snapshotsDir = path.resolve(dir);
}

export function getSnapshotsDir(): string {
  return snapshotsDir;
}

/** Test helper to tighten retention without waiting 7 days / creating 50 snaps. */
export function setSnapshotRetention(opts: { maxSnapshots?: number; maxAgeMs?: number }): void {
  if (opts.maxSnapshots !== undefined) {
    if (!Number.isFinite(opts.maxSnapshots) || opts.maxSnapshots < 1) {
      throw new Error("maxSnapshots must be a positive number");
    }
    maxSnapshots = Math.floor(opts.maxSnapshots);
  }
  if (opts.maxAgeMs !== undefined) {
    if (!Number.isFinite(opts.maxAgeMs) || opts.maxAgeMs < 0) {
      throw new Error("maxAgeMs must be a non-negative number");
    }
    maxAgeMs = Math.floor(opts.maxAgeMs);
  }
}

export function resetSnapshotRetention(): void {
  maxSnapshots = MAX_SNAPSHOTS_DEFAULT;
  maxAgeMs = MAX_AGE_MS_DEFAULT;
}

export interface SnapshotMetadata {
  id: string;
  ts: string;
  tool: string;
  path: string;
  prev_hash: string;
  blob_path: string;
  workspace?: string;
}

function humanError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

function dateFolder(ts: Date = new Date()): string {
  const y = ts.getUTCFullYear();
  const m = String(ts.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ts.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readMetadataFile(metaPath: string): Promise<SnapshotMetadata | null> {
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as SnapshotMetadata;
    if (!parsed.id || !parsed.ts || !parsed.path || !parsed.blob_path) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function collectAllMetadata(): Promise<SnapshotMetadata[]> {
  const results: SnapshotMetadata[] = [];
  try {
    const days = await fs.readdir(snapshotsDir, { withFileTypes: true });
    for (const day of days) {
      if (!day.isDirectory()) continue;
      const dayDir = path.join(snapshotsDir, day.name);
      let files: string[];
      try {
        files = await fs.readdir(dayDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const meta = await readMetadataFile(path.join(dayDir, file));
        if (meta) results.push(meta);
      }
    }
  } catch {
    // no snapshots dir yet
  }
  results.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return results;
}

async function removeSnapshot(meta: SnapshotMetadata): Promise<void> {
  const day = dateFolder(new Date(meta.ts));
  const metaPath = path.join(snapshotsDir, day, `${meta.id}.json`);
  try {
    await fs.unlink(meta.blob_path);
  } catch {
    // blob may already be gone
  }
  try {
    await fs.unlink(metaPath);
  } catch {
    // meta may already be gone
  }
}

async function enforceRetention(): Promise<void> {
  const all = await collectAllMetadata();
  const now = Date.now();
  const expired = all.filter((m) => {
    const t = Date.parse(m.ts);
    return Number.isFinite(t) && now - t > maxAgeMs;
  });
  for (const m of expired) {
    await removeSnapshot(m);
  }

  const remaining = (await collectAllMetadata()).sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
  );
  while (remaining.length > maxSnapshots) {
    const oldest = remaining.shift();
    if (!oldest) break;
    await removeSnapshot(oldest);
  }
}

/**
 * Snapshot an existing file before a mutating filesystem tool runs.
 * No-ops (returns null) if the path does not exist or is not a regular file.
 */
export async function createSnapshotBeforeMutation(opts: {
  tool: string;
  path: string;
  workspace?: string;
}): Promise<SnapshotMetadata | null> {
  const filePath = path.isAbsolute(opts.path) ? opts.path : resolveToolPath(opts.path);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const content = await fs.readFile(filePath);
  const prev_hash = crypto.createHash("sha256").update(content).digest("hex");
  const compressed = await gzipAsync(content);

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const day = dateFolder(new Date(ts));
  const dayDir = path.join(snapshotsDir, day);
  await ensureDir(dayDir);

  const blob_path = path.join(dayDir, `${id}.bin`);
  const meta_path = path.join(dayDir, `${id}.json`);

  await fs.writeFile(blob_path, compressed);

  const workspace =
    opts.workspace ?? getWorkspaceContext().root ?? undefined;

  const meta: SnapshotMetadata = {
    id,
    ts,
    tool: opts.tool,
    path: filePath,
    prev_hash,
    blob_path,
    ...(workspace ? { workspace } : {}),
  };

  await fs.writeFile(meta_path, JSON.stringify(meta, null, 2), "utf-8");
  await enforceRetention();
  return meta;
}

async function findSnapshotById(id: string): Promise<SnapshotMetadata | null> {
  const all = await collectAllMetadata();
  return all.find((m) => m.id === id) ?? null;
}

export async function list_snapshots(args: ListSnapshotsArgs): Promise<ToolResponse> {
  const parsed = ListSnapshotsArgsSchema.parse(args);
  const limit = parsed.limit;

  try {
    let all = await collectAllMetadata();

    if (parsed.path !== undefined) {
      const filterPath = resolveToolPath(parsed.path);
      all = all.filter((m) => m.path === filterPath || m.path.startsWith(filterPath + path.sep));
    }

    const slice = all.slice(0, limit).map((m) => ({
      id: m.id,
      ts: m.ts,
      tool: m.tool,
      path: m.path,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ snapshots: slice, count: slice.length }, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to list snapshots: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}

export async function restore_snapshot(args: RestoreSnapshotArgs): Promise<ToolResponse> {
  const parsed = RestoreSnapshotArgsSchema.parse(args);

  try {
    const meta = await findSnapshotById(parsed.id);
    if (!meta) {
      return {
        content: [{ type: "text", text: `Snapshot not found: ${parsed.id}` }],
        isError: true,
      };
    }

    // Snapshot current file before overwriting (if it exists)
    await createSnapshotBeforeMutation({
      tool: "restore_snapshot",
      path: meta.path,
    });

    let compressed: Buffer;
    try {
      compressed = await fs.readFile(meta.blob_path);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to read snapshot blob for ${parsed.id}: ${humanError(err, "unknown error")}`,
          },
        ],
        isError: true,
      };
    }

    let content: Buffer;
    try {
      content = await gunzipAsync(compressed);
    } catch {
      // Fall back to plain blob if not gzip-compressed
      content = compressed;
    }

    await ensureDir(path.dirname(meta.path));
    const tmpPath = `${meta.path}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, meta.path);

    return {
      content: [
        {
          type: "text",
          text: `Restored snapshot ${meta.id} to ${meta.path} (${content.length} bytes)`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to restore snapshot ${parsed.id}: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}
