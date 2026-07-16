#!/usr/bin/env node
/**
 * Fail CI when the CLI's bundled Worker assets drift from packages/cloudflare-worker.
 * Regenerate with: npm run bundle:cli
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'packages', 'cloudflare-worker');
const assetRoot = path.join(root, 'packages', 'cli', 'assets', 'worker');
const checkedEntries = ['wrangler.jsonc', 'package.json', 'tsconfig.json', 'src'];

function listFiles(baseDir, relativeEntry = '') {
  const target = path.join(baseDir, relativeEntry);
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [relativeEntry];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(relativeEntry, entry.name);
      if (entry.isDirectory()) {
        return listFiles(baseDir, relativePath);
      }
      if (entry.isFile()) {
        return [relativePath];
      }
      return [];
    })
    .sort();
}

function readBuffer(filePath) {
  return fs.readFileSync(filePath);
}

function main() {
  const missing = [];
  const sourceFiles = [];
  const assetFiles = [];

  for (const entry of checkedEntries) {
    const sourcePath = path.join(sourceRoot, entry);
    const assetPath = path.join(assetRoot, entry);
    if (!fs.existsSync(sourcePath)) {
      missing.push(`source missing: ${path.relative(root, sourcePath)}`);
      continue;
    }
    if (!fs.existsSync(assetPath)) {
      missing.push(`asset missing: ${path.relative(root, assetPath)}`);
      continue;
    }
    sourceFiles.push(...listFiles(sourceRoot, entry));
    assetFiles.push(...listFiles(assetRoot, entry));
  }

  const sourceSet = new Set(sourceFiles);
  const assetSet = new Set(assetFiles);
  const onlySource = sourceFiles.filter((file) => !assetSet.has(file));
  const onlyAssets = assetFiles.filter((file) => !sourceSet.has(file));
  const changed = sourceFiles.filter((file) => {
    if (!assetSet.has(file)) return false;
    return !readBuffer(path.join(sourceRoot, file)).equals(readBuffer(path.join(assetRoot, file)));
  });

  if (missing.length > 0 || onlySource.length > 0 || onlyAssets.length > 0 || changed.length > 0) {
    console.error('Worker asset drift detected.');
    console.error('Run `npm run bundle:cli` and commit the updated packages/cli/assets/worker files.');
    for (const item of missing) {
      console.error(`  ${item}`);
    }
    for (const file of onlySource) {
      console.error(`  only in packages/cloudflare-worker: ${file}`);
    }
    for (const file of onlyAssets) {
      console.error(`  only in packages/cli/assets/worker: ${file}`);
    }
    for (const file of changed) {
      console.error(`  content differs: ${file}`);
    }
    process.exit(1);
  }

  console.log('Worker assets are in sync.');
}

main();
