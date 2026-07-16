/**
 * Unit tests for safer uninstall planning.
 * No service, filesystem deletion, worker deletion, or network side effects.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseUninstallFlags,
  runUninstall,
  unregisterConfiguredDevice
} from '../dist/uninstall.js';

function baseConfig(overrides = {}) {
  return {
    device_id: '11111111-1111-4111-8111-111111111111',
    token: 't'.repeat(32),
    worker_url: 'https://deckagent.example.workers.dev',
    device_name: 'test-device',
    api_token: 'a'.repeat(32),
    heartbeat_interval: 15,
    tool_timeout: 60,
    auto_connect: true,
    log_level: 'info',
    ...overrides
  };
}

async function testDryRunDeletesNothing() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-uninstall-'));
  const configDir = path.join(root, '.deckagent');
  const logDir = path.join(configDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), '{}\n');
  fs.writeFileSync(path.join(configDir, 'secrets.json'), '{}\n');
  fs.writeFileSync(path.join(logDir, 'deckagent.log'), 'hello\n');

  let uninstallCalled = false;
  let deleteWorkerCalled = false;
  const lines = [];

  try {
    await runUninstall(['--dry-run', '--delete-worker', '--unregister-device'], {
      configDir,
      logDir,
      readConfig: () => baseConfig(),
      uninstallDaemonService: () => {
        uninstallCalled = true;
      },
      deleteWorker: () => {
        deleteWorkerCalled = true;
      },
      fetch: async () => {
        throw new Error('fetch should not be called in dry-run');
      },
      writeLine: (line) => lines.push(line)
    });

    assert.equal(uninstallCalled, false);
    assert.equal(deleteWorkerCalled, false);
    assert.equal(fs.existsSync(path.join(configDir, 'config.json')), true);
    assert.equal(fs.existsSync(path.join(configDir, 'secrets.json')), true);
    assert.equal(fs.existsSync(path.join(logDir, 'deckagent.log')), true);
    assert.match(lines.join('\n'), /Dry run: no changes will be made/);
    assert.match(lines.join('\n'), /DELETE https:\/\/deckagent\.example\.workers\.dev\/api\/devices\/11111111-1111-4111-8111-111111111111/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testUnregisterDeviceRequest() {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  await unregisterConfiguredDevice(baseConfig(), fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0].input),
    'https://deckagent.example.workers.dev/api/devices/11111111-1111-4111-8111-111111111111'
  );
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${'a'.repeat(32)}`);
}

function testFlagParsing() {
  const flags = parseUninstallFlags([
    '--dry-run',
    '--keep-config',
    '--keep-logs',
    '--delete-worker',
    '--unregister-device',
    '--yes'
  ]);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.keepConfig, true);
  assert.equal(flags.keepLogs, true);
  assert.equal(flags.deleteWorker, true);
  assert.equal(flags.unregisterDevice, true);
  assert.equal(flags.yes, true);
  assert.throws(() => parseUninstallFlags(['--unknown']), /Unknown uninstall option/);
}

await testDryRunDeletesNothing();
await testUnregisterDeviceRequest();
testFlagParsing();
console.log('All uninstall tests passed.');
