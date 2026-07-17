/**
 * Unit tests for worker/daemon path resolution (sibling vs bundled assets).
 * No network. Run via: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWorkerPackageCandidates } from '../dist/paths.js';
import { resolveWorkerPackageDir } from '../dist/deploy-worker.js';
import { resolveDaemonPaths } from '../dist/install-daemon.js';

function makeTempCliRoot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-cli-'));
  const cliRoot = path.join(root, 'cli');
  fs.mkdirSync(cliRoot, { recursive: true });

  if (opts.withSiblingWorker) {
    const sibling = path.join(root, 'cloudflare-worker');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'wrangler.jsonc'), '{ "name": "sibling" }\n');
  }

  if (opts.withAssetsWorker) {
    const assets = path.join(cliRoot, 'assets', 'worker');
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'wrangler.jsonc'), '{ "name": "assets" }\n');
  }

  return { cliRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function testCandidatesOrder() {
  const cliRoot = '/tmp/fake-cli';
  const candidates = getWorkerPackageCandidates(cliRoot);
  assert.equal(candidates.length, 2);
  assert.ok(candidates[0].endsWith(`${path.sep}cloudflare-worker`));
  assert.ok(candidates[1].endsWith(path.join('assets', 'worker')));
}

function testPrefersSiblingWhenPresent() {
  const { cliRoot, cleanup } = makeTempCliRoot({ withSiblingWorker: true, withAssetsWorker: true });
  try {
    const resolved = resolveWorkerPackageDir({ cliPackageRoot: cliRoot });
    assert.ok(resolved.includes('cloudflare-worker'));
    assert.ok(!resolved.includes(path.join('assets', 'worker')));
    const wrangler = fs.readFileSync(path.join(resolved, 'wrangler.jsonc'), 'utf-8');
    assert.match(wrangler, /sibling/);
  } finally {
    cleanup();
  }
}

function testFallsBackToAssetsWhenSiblingMissing() {
  const { cliRoot, cleanup } = makeTempCliRoot({ withSiblingWorker: false, withAssetsWorker: true });
  try {
    const resolved = resolveWorkerPackageDir({ cliPackageRoot: cliRoot });
    assert.ok(resolved.includes(path.join('assets', 'worker')));
    const wrangler = fs.readFileSync(path.join(resolved, 'wrangler.jsonc'), 'utf-8');
    assert.match(wrangler, /assets/);
  } finally {
    cleanup();
  }
}

function testThrowsWhenNeitherPresent() {
  const { cliRoot, cleanup } = makeTempCliRoot({ withSiblingWorker: false, withAssetsWorker: false });
  try {
    assert.throws(
      () => resolveWorkerPackageDir({ cliPackageRoot: cliRoot }),
      /Cloudflare Worker package not found/
    );
  } finally {
    cleanup();
  }
}

function testDaemonSiblingResolution() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-daemon-'));
  const cliRoot = path.join(root, 'cli');
  const daemon = path.join(root, 'desktop-daemon');
  fs.mkdirSync(cliRoot, { recursive: true });
  fs.mkdirSync(path.join(daemon, 'dist', 'src'), { recursive: true });
  fs.writeFileSync(path.join(daemon, 'dist', 'src', 'index.js'), 'export {};\n');
  try {
    const paths = resolveDaemonPaths({ cliPackageRoot: cliRoot });
    assert.equal(paths.packageDir, daemon);
    assert.ok(paths.distFile.endsWith(path.join('dist', 'src', 'index.js')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

assert.equal(typeof getWorkerPackageCandidates, 'function');
assert.equal(typeof resolveWorkerPackageDir, 'function');

testCandidatesOrder();
testPrefersSiblingWhenPresent();
testFallsBackToAssetsWhenSiblingMissing();
testThrowsWhenNeitherPresent();
testDaemonSiblingResolution();
console.log('All resolve-paths tests passed.');
