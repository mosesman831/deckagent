/**
 * Unit tests for workspace path helpers (Wave 3.1 F1).
 * No network. Run via: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWorkspacePath,
  ensureAllowedDirectory,
  isCoveredByAllowedDirectory
} from '../dist/workspace.js';
import { ConfigSchema } from '../dist/configure.js';

function testResolveWorkspacePathExpandsHomeAndRequiresDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-ws-'));
  try {
    const resolved = resolveWorkspacePath(dir);
    assert.equal(resolved, path.resolve(dir));

    // ~ expansion when pointing at a real subdir under home is hard to guarantee;
    // at least relative paths resolve to absolute existing dirs.
    const nested = path.join(dir, 'proj');
    fs.mkdirSync(nested);
    assert.equal(resolveWorkspacePath(nested), path.resolve(nested));

    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    assert.throws(() => resolveWorkspacePath(file), /not a directory/);

    assert.throws(() => resolveWorkspacePath(path.join(dir, 'missing')), /does not exist/);
    assert.throws(() => resolveWorkspacePath(''), /required/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testEnsureAllowedDirectoryAddsWhenUncovered() {
  const root = '/tmp/my-project';
  const policy = {
    version: 1,
    allowed_directories: ['/home/user/Documents'],
    blocked_commands: [],
    require_confirmation: [],
    read_only: false,
    allow_browser: true,
    allow_terminal: true,
    allow_computer_use: false,
    command_mode: 'blocklist',
    allowed_commands: [],
    max_file_read_size: 1024,
    max_command_timeout: 60
  };

  assert.equal(isCoveredByAllowedDirectory(root, policy.allowed_directories), false);

  const { policy: updated, added } = ensureAllowedDirectory(policy, root);
  assert.equal(added, true);
  assert.ok(updated.allowed_directories.includes(root));
  assert.equal(policy.allowed_directories.length, 1); // original unchanged
}

function testEnsureAllowedDirectorySkipsWhenPrefixCovered() {
  const root = '/home/user/code/app';
  const policy = {
    version: 1,
    allowed_directories: ['/home/user/code'],
    blocked_commands: [],
    require_confirmation: [],
    read_only: false,
    allow_browser: true,
    allow_terminal: true,
    allow_computer_use: false,
    command_mode: 'blocklist',
    allowed_commands: [],
    max_file_read_size: 1024,
    max_command_timeout: 60
  };

  assert.equal(isCoveredByAllowedDirectory(root, policy.allowed_directories), true);
  const { policy: updated, added } = ensureAllowedDirectory(policy, root);
  assert.equal(added, false);
  assert.deepEqual(updated.allowed_directories, policy.allowed_directories);
}

function testEnsureAllowedDirectorySkipsExactMatch() {
  const root = '/tmp/ws';
  const { added } = ensureAllowedDirectory(
    {
      version: 1,
      allowed_directories: [root],
      blocked_commands: [],
      require_confirmation: [],
      read_only: false,
      allow_browser: true,
      allow_terminal: true,
      allow_computer_use: false,
      command_mode: 'blocklist',
      allowed_commands: [],
      max_file_read_size: 1024,
      max_command_timeout: 60
    },
    root
  );
  assert.equal(added, false);
}

function testConfigSchemaPreservesWorkspace() {
  const raw = {
    device_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    token: 'a'.repeat(32),
    worker_url: 'https://example.workers.dev',
    device_name: 'test-host',
    api_token: 'b'.repeat(32),
    workspace: {
      root: '/tmp/project',
      name: 'project',
      allow_outside_with_confirmation: true
    }
  };

  const parsed = ConfigSchema.parse(raw);
  assert.ok(parsed.workspace);
  assert.equal(parsed.workspace.root, '/tmp/project');
  assert.equal(parsed.workspace.name, 'project');
  assert.equal(parsed.workspace.allow_outside_with_confirmation, true);

  // Round-trip without workspace must not invent one
  const { workspace: _w, ...without } = parsed;
  const cleared = ConfigSchema.parse(without);
  assert.equal(cleared.workspace, undefined);
}

testResolveWorkspacePathExpandsHomeAndRequiresDir();
testEnsureAllowedDirectoryAddsWhenUncovered();
testEnsureAllowedDirectorySkipsWhenPrefixCovered();
testEnsureAllowedDirectorySkipsExactMatch();
testConfigSchemaPreservesWorkspace();
console.log('All workspace tests passed.');
