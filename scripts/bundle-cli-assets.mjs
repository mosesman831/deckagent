#!/usr/bin/env node
/**
 * Copy Cloudflare Worker sources into packages/cli/assets/worker so a published
 * `@deckagent/cli` package (npx @deckagent/cli) can deploy without the monorepo tree.
 *
 * Usage: node scripts/bundle-cli-assets.mjs
 * Also run via: npm run bundle:cli
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const workerSrc = path.join(root, 'packages', 'cloudflare-worker');
const workerDest = path.join(root, 'packages', 'cli', 'assets', 'worker');

const WORKER_FILES = ['wrangler.jsonc', 'package.json', 'tsconfig.json'];
const WORKER_DIRS = ['src'];

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      copyFile(from, to);
    }
  }
}

function main() {
  if (!fs.existsSync(workerSrc)) {
    console.error(`Worker package not found at ${workerSrc}`);
    process.exit(1);
  }

  rmrf(workerDest);
  fs.mkdirSync(workerDest, { recursive: true });

  for (const file of WORKER_FILES) {
    const src = path.join(workerSrc, file);
    if (!fs.existsSync(src)) {
      console.error(`Missing required worker file: ${src}`);
      process.exit(1);
    }
    copyFile(src, path.join(workerDest, file));
  }

  for (const dir of WORKER_DIRS) {
    const src = path.join(workerSrc, dir);
    if (!fs.existsSync(src)) {
      console.error(`Missing required worker directory: ${src}`);
      process.exit(1);
    }
    copyDir(src, path.join(workerDest, dir));
  }

  // Notes for published installs live in assets/README.md (committed).
  // Daemon is resolved from the @deckagent/desktop-daemon dependency, not copied here.

  console.log(`Bundled worker assets → ${workerDest}`);
}

main();
