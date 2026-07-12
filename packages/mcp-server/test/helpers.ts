import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createDefaultToolRegistry } from '../src/index.js';
import type { ToolRegistry } from '../src/index.js';

/** Create a fresh temp directory and a registry scoped to it. */
export async function makeSandbox(): Promise<{ dir: string; registry: ToolRegistry }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckagent-test-'));
  const registry = createDefaultToolRegistry({
    allowedDirectories: [dir],
    homeDir: dir,
  });
  return { dir, registry };
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Concatenate all text blocks of a ToolResponse. */
export function responseText(res: { content: Array<{ type: string; text: string }> }): string {
  return res.content.map((c) => c.text).join('\n');
}
