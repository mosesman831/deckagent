/**
 * Unit tests for plugin CLI helpers (W5.6).
 * No daemon required. Run via: npm test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverPlugins,
  hashFileSha256,
  hashPluginByName
} from '../dist/plugin.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-cli-plugin-'));
const root = path.join(dir, 'plugins');
const okDir = path.join(root, 'ok');
const missingDir = path.join(root, 'missing');
const badDir = path.join(root, 'bad');

function writePlugin(pluginDir, manifest) {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'index.mjs'),
    'export async function run() { return { content: [{ type: "text", text: "ok" }] }; }\n'
  );
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
}

try {
  fs.mkdirSync(root, { recursive: true });

  writePlugin(okDir, {
    name: 'ok_plugin',
    description: 'Pinned plugin',
    version: '1.0.0',
    entry: 'index.mjs',
    inputSchema: { type: 'object', properties: {} },
    require_confirmation: false
  });
  const okHash = hashFileSha256(path.join(okDir, 'index.mjs'));
  const okManifest = JSON.parse(fs.readFileSync(path.join(okDir, 'plugin.json'), 'utf-8'));
  okManifest.integrity = { sha256: okHash };
  fs.writeFileSync(path.join(okDir, 'plugin.json'), JSON.stringify(okManifest, null, 2) + '\n');

  writePlugin(missingDir, {
    name: 'missing_plugin',
    description: 'Missing integrity plugin',
    version: '1.0.0',
    entry: 'index.mjs',
    inputSchema: { type: 'object', properties: {} },
    require_confirmation: false
  });

  writePlugin(badDir, {
    name: 'bad_plugin',
    description: 'Bad integrity plugin',
    version: '1.0.0',
    entry: 'index.mjs',
    inputSchema: { type: 'object', properties: {} },
    require_confirmation: false,
    integrity: { sha256: '0'.repeat(64) }
  });

  const rows = discoverPlugins(root, true, true);
  const byName = new Map(rows.map((row) => [row.name, row]));
  assert.equal(byName.get('ok_plugin').integrityStatus, 'ok');
  assert.equal(byName.get('ok_plugin').enabled, true);
  assert.equal(byName.get('missing_plugin').integrityStatus, 'missing');
  assert.equal(byName.get('missing_plugin').enabled, false);
  assert.match(byName.get('missing_plugin').error, /PLUGIN_INTEGRITY_MISSING/);
  assert.equal(byName.get('bad_plugin').integrityStatus, 'mismatch');
  assert.equal(byName.get('bad_plugin').enabled, false);
  assert.match(byName.get('bad_plugin').error, /PLUGIN_INTEGRITY_MISMATCH/);

  const hash = hashPluginByName('ok_plugin', root);
  assert.equal(hash.sha256, okHash);
  assert.equal(hash.name, 'ok_plugin');
  assert.equal(path.basename(hash.entry), 'index.mjs');

  assert.throws(() => hashPluginByName('not_here', root), /Plugin not found/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
