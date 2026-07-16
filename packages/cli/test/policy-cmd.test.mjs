/**
 * Unit tests for policy trust/deny path helpers (Wave 4 S8).
 * No network. Run via: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addDeniedDirectory,
  addTrustedDirectory,
  applySetProfile,
  expandPolicyPath
} from '../dist/policy-cmd.js';
import { PolicySchema, generateDefaultPolicy } from '../dist/configure.js';

function minimalPolicy(overrides = {}) {
  return PolicySchema.parse({
    profile: 'strict',
    trusted_directories: [],
    allowed_directories: [],
    denied_directories: [],
    ...overrides
  });
}

function testExpandPolicyPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-policy-'));
  try {
    const resolved = expandPolicyPath(dir);
    assert.equal(resolved, path.resolve(dir));

    const homeRel = expandPolicyPath('~/DeckAgent-test-expand');
    assert.equal(homeRel, path.resolve(path.join(os.homedir(), 'DeckAgent-test-expand')));

    assert.throws(() => expandPolicyPath(''), /required/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testTrustAddsToTrustedAndAllowed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-trust-'));
  try {
    const policy = minimalPolicy();
    const { policy: updated, path: abs, added } = addTrustedDirectory(policy, dir);
    assert.equal(added, true);
    assert.equal(abs, path.resolve(dir));
    assert.ok(updated.trusted_directories.includes(abs));
    assert.ok(updated.allowed_directories.includes(abs));
    assert.equal(policy.trusted_directories.length, 0);

    const again = addTrustedDirectory(updated, dir);
    assert.equal(again.added, false);
    assert.equal(again.policy.trusted_directories.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDenyAddsToDenied() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-deny-'));
  try {
    const nested = path.join(dir, '.env');
    const policy = minimalPolicy({
      trusted_directories: [dir],
      allowed_directories: [dir]
    });
    const { policy: updated, path: abs, added } = addDeniedDirectory(policy, nested);
    assert.equal(added, true);
    assert.equal(abs, path.resolve(nested));
    assert.ok(updated.denied_directories.includes(abs));

    const again = addDeniedDirectory(updated, nested);
    assert.equal(again.added, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testSetProfileStrictDefaults() {
  const policy = generateDefaultPolicy({
    profile: 'dev',
    allow_browser: true,
    allow_terminal: true,
    trusted_directories: ['/tmp/proj'],
    allowed_directories: ['/tmp/proj']
  });
  const strict = applySetProfile(policy, 'strict');
  assert.equal(strict.profile, 'strict');
  assert.equal(strict.profile_locked, false);
  assert.equal(strict.command_mode, 'allowlist');
  assert.equal(strict.allow_browser, false);
  assert.equal(strict.allow_secret_injection, false);
  assert.ok(strict.allowed_commands.includes('git'));
}

function testSetProfileLocked() {
  const policy = generateDefaultPolicy({ profile: 'strict' });
  const locked = applySetProfile(policy, 'locked');
  assert.equal(locked.profile, 'locked');
  assert.equal(locked.profile_locked, true);
}

function testGenerateDefaultIsStrict() {
  const policy = generateDefaultPolicy();
  assert.equal(policy.profile, 'strict');
  assert.equal(policy.command_mode, 'allowlist');
  assert.equal(policy.allow_browser, false);
  assert.ok(policy.trusted_directories.length >= 1 || policy.allowed_directories.length >= 1);
}

testExpandPolicyPath();
testTrustAddsToTrustedAndAllowed();
testDenyAddsToDenied();
testSetProfileStrictDefaults();
testSetProfileLocked();
testGenerateDefaultIsStrict();
console.log('All policy-cmd tests passed.');
