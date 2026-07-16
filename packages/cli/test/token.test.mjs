/**
 * Unit tests for token rotation.
 * No Cloudflare calls. Uses an injected temp config file instead of ~/.deckagent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTokenCommand, rotateApiToken } from '../dist/token.js';

function baseConfig(overrides = {}) {
  return {
    device_id: '11111111-1111-4111-8111-111111111111',
    token: 't'.repeat(32),
    worker_url: 'https://deckagent.example.workers.dev',
    device_name: 'test-device',
    api_token: 'a'.repeat(64),
    heartbeat_interval: 15,
    tool_timeout: 60,
    auto_connect: true,
    log_level: 'info',
    ...overrides
  };
}

async function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-token-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2) + '\n', { mode: 0o600 });
  try {
    return await fn(configPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readConfigFile(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfigFile(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function testRotateApiTokenPure() {
  const updated = rotateApiToken(baseConfig(), () => 'b'.repeat(64));
  assert.equal(updated.api_token, 'b'.repeat(64));
  assert.equal(updated.device_id, '11111111-1111-4111-8111-111111111111');
}

async function testRunTokenRotateWritesNewToken() {
  await withTempConfig(async (configPath) => {
    const lines = [];
    const result = await runTokenCommand(['rotate'], {
      readConfig: () => readConfigFile(configPath),
      writeConfig: (config) => writeConfigFile(configPath, config),
      generateToken: () => 'c'.repeat(64),
      resolveWorkerDir: () => '/tmp/deckagent-worker',
      writeLine: (line) => lines.push(line)
    });

    const written = readConfigFile(configPath);
    assert.equal(written.api_token, 'c'.repeat(64));
    assert.equal(result.previousToken, 'a'.repeat(64));
    assert.equal(result.newToken, 'c'.repeat(64));
    assert.equal(result.deployed, false);
    assert.match(lines.join('\n'), /wrangler secret put API_TOKEN/);
    assert.match(lines.join('\n'), /MCP connector/);
  });
}

async function testRunTokenRotateDeploysWhenRequested() {
  await withTempConfig(async (configPath) => {
    const deployed = [];
    const result = await runTokenCommand(['rotate', '--deploy'], {
      readConfig: () => readConfigFile(configPath),
      writeConfig: (config) => writeConfigFile(configPath, config),
      generateToken: () => 'd'.repeat(64),
      isWranglerAvailable: () => true,
      deploySecret: (token) => deployed.push(token),
      writeLine: () => undefined
    });

    assert.deepEqual(deployed, ['d'.repeat(64)]);
    assert.equal(readConfigFile(configPath).api_token, 'd'.repeat(64));
    assert.equal(result.deployed, true);
  });
}

testRotateApiTokenPure();
await testRunTokenRotateWritesNewToken();
await testRunTokenRotateDeploysWhenRequested();
console.log('All token tests passed.');
