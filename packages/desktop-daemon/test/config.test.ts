import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigSchema, loadConfig, saveConfig, getConfigPath } from '../src/config.js';

/**
 * Point HOME at a fresh temp dir so config reads/writes hit an isolated
 * `~/.deckagent`. Node's `os.homedir()` honors $HOME on POSIX.
 */
function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-cfg-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

test('getConfigPath points at ~/.deckagent/config.json', () => {
  const home = withTempHome();
  assert.equal(getConfigPath(), path.join(home, '.deckagent', 'config.json'));
});

test('loadConfig throws a helpful error when the file is missing', () => {
  withTempHome();
  assert.throws(() => loadConfig(), /Config not found/);
});

test('saveConfig then loadConfig round-trips and fills defaults', () => {
  withTempHome();
  const config = ConfigSchema.parse({
    device_id: '11111111-2222-3333-4444-555555555555',
    token: 'abc123',
    worker_url: 'https://deckagent.example.workers.dev',
    device_name: 'Test Box',
  });

  saveConfig(config);
  assert.ok(fs.existsSync(getConfigPath()));

  const loaded = loadConfig();
  assert.equal(loaded.device_id, config.device_id);
  assert.equal(loaded.worker_url, config.worker_url);
  // Defaults from the schema.
  assert.equal(loaded.heartbeat_interval, 15);
  assert.equal(loaded.tool_timeout, 60);
  assert.equal(loaded.auto_connect, true);
  assert.equal(loaded.log_level, 'info');
});

test('loadConfig rejects an invalid device_id', () => {
  withTempHome();
  fs.mkdirSync(path.join(process.env.HOME as string, '.deckagent'), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({
      device_id: 'not-a-uuid',
      token: 'x',
      worker_url: 'https://ok.example.com',
      device_name: 'n',
    }),
  );
  assert.throws(() => loadConfig(), /invalid/i);
});
