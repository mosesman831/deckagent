import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadPolicy,
  getPolicyPath,
  isPathAllowed,
  isCommandBlocked,
  needsConfirmation,
  validateToolCall,
  DEFAULT_POLICY,
  type Policy,
} from '../src/policy.js';

function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-pol-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

test('loadPolicy writes and returns the default policy when none exists', () => {
  withTempHome();
  const policy = loadPolicy();
  assert.equal(policy.version, 1);
  assert.deepEqual(policy.allowed_directories, ['~']);
  assert.equal(policy.read_only, false);
  assert.equal(policy.allow_browser, true);
  assert.equal(policy.max_file_read_size, 10485760);
  assert.ok(fs.existsSync(getPolicyPath()));
});

test('isPathAllowed enforces directory prefixes and rejects escapes', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-allow-')));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hi');
  assert.equal(isPathAllowed(path.join(dir, 'file.txt'), [dir]), true);
  assert.equal(isPathAllowed(path.join(dir, 'nested', 'deep.txt'), [dir]), true);
  assert.equal(isPathAllowed('/etc/passwd', [dir]), false);
  assert.equal(isPathAllowed(`${dir}-sibling/x`, [dir]), false);
  // Empty allow-list means unrestricted.
  assert.equal(isPathAllowed('/anything', []), true);
});

test('isCommandBlocked matches substrings case-insensitively', () => {
  const blocked = ['rm -rf', 'sudo'];
  assert.equal(isCommandBlocked('sudo apt update', blocked), true);
  assert.equal(isCommandBlocked('echo SUDO', blocked), true);
  assert.equal(isCommandBlocked('rm -rf /tmp/x', blocked), true);
  assert.equal(isCommandBlocked('ls -la', blocked), false);
});

test('needsConfirmation checks the require_confirmation list', () => {
  assert.equal(needsConfirmation('kill_process', ['kill_process']), true);
  assert.equal(needsConfirmation('read_file', ['kill_process']), false);
});

test('validateToolCall enforces read_only for mutating tools', () => {
  const policy: Policy = { ...DEFAULT_POLICY, read_only: true, allowed_directories: [] };
  assert.equal(validateToolCall('write_file', { path: '/x' }, policy).allowed, false);
  assert.equal(validateToolCall('read_file', { path: '/x' }, policy).allowed, true);
});

test('validateToolCall gates browser and terminal tools', () => {
  const noBrowser: Policy = { ...DEFAULT_POLICY, allow_browser: false, allowed_directories: [] };
  assert.equal(validateToolCall('browser_navigate', { url: 'https://x' }, noBrowser).allowed, false);

  const noTerminal: Policy = { ...DEFAULT_POLICY, allow_terminal: false, allowed_directories: [] };
  assert.equal(validateToolCall('list_processes', {}, noTerminal).allowed, false);
});

test('validateToolCall blocks commands and out-of-scope paths', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-vtc-')));
  const policy: Policy = {
    ...DEFAULT_POLICY,
    require_confirmation: [],
    allowed_directories: [dir],
  };

  assert.equal(validateToolCall('execute_command', { command: 'sudo rm' }, policy).allowed, false);
  assert.equal(validateToolCall('execute_command', { command: 'ls' }, policy).allowed, true);

  assert.equal(validateToolCall('read_file', { path: '/etc/passwd' }, policy).allowed, false);
  assert.equal(validateToolCall('read_file', { path: path.join(dir, 'ok.txt') }, policy).allowed, true);
});

test('validateToolCall flags tools requiring confirmation', () => {
  const policy: Policy = {
    ...DEFAULT_POLICY,
    allowed_directories: [],
    require_confirmation: ['kill_process'],
  };
  const result = validateToolCall('kill_process', { pid: 123 }, policy);
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /confirmation/i);
});
