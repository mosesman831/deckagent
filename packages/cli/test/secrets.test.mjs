/**
 * Unit tests for secrets vault helpers (Wave 3 F4).
 * No network. Uses temp baseDir. Run via: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setSecret,
  listSecrets,
  deleteSecret,
  readSecretsFile,
  getSecretsPath,
  runSecretCommand,
  validateSecretName
} from '../dist/secrets.js';
import { PolicySchema, DEFAULT_REQUIRE_CONFIRMATION, DEFAULT_BUDGETS } from '../dist/configure.js';
import { CONTROL_UI_URL } from '../dist/ui.js';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-secrets-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testSetListDeleteRoundTrip() {
  withTempDir((baseDir) => {
    assert.deepEqual(listSecrets(baseDir), []);

    const { created } = setSecret('GITHUB_TOKEN', 'ghp_test_secret_value', baseDir);
    assert.equal(created, true);

    const names = listSecrets(baseDir);
    assert.deepEqual(names, ['GITHUB_TOKEN']);

    const file = readSecretsFile(baseDir);
    assert.equal(file.version, 1);
    assert.equal(file.secrets.GITHUB_TOKEN.value, 'ghp_test_secret_value');
    assert.ok(file.secrets.GITHUB_TOKEN.created_at);

    const secretsPath = getSecretsPath(baseDir);
    assert.ok(fs.existsSync(secretsPath));
    const mode = fs.statSync(secretsPath).mode & 0o777;
    // On Linux we expect 0600; skip strict assert on platforms that ignore mode bits.
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600);
    }

    const updated = setSecret('GITHUB_TOKEN', 'new_value', baseDir);
    assert.equal(updated.created, false);
    assert.equal(readSecretsFile(baseDir).secrets.GITHUB_TOKEN.value, 'new_value');

    setSecret('API_KEY', 'abc', baseDir);
    assert.deepEqual(listSecrets(baseDir), ['API_KEY', 'GITHUB_TOKEN']);

    assert.equal(deleteSecret('GITHUB_TOKEN', baseDir), true);
    assert.deepEqual(listSecrets(baseDir), ['API_KEY']);
    assert.equal(deleteSecret('GITHUB_TOKEN', baseDir), false);
  });
}

async function testRunSecretCommandWithInjectedReader() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-secrets-cmd-'));
  try {
    await runSecretCommand(['set', 'MY_SECRET'], {
      baseDir: dir,
      readValue: async () => 'injected-value'
    });
    assert.deepEqual(listSecrets(dir), ['MY_SECRET']);
    assert.equal(readSecretsFile(dir).secrets.MY_SECRET.value, 'injected-value');

    await runSecretCommand(['list'], { baseDir: dir });
    await runSecretCommand(['delete', 'MY_SECRET'], { baseDir: dir });
    assert.deepEqual(listSecrets(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testValidateSecretName() {
  assert.equal(validateSecretName('GITHUB_TOKEN'), 'GITHUB_TOKEN');
  assert.throws(() => validateSecretName(''), /required/i);
  assert.throws(() => validateSecretName('bad-name'), /Invalid secret name/);
  assert.throws(() => validateSecretName('1ABC'), /Invalid secret name/);
}

function testPolicySchemaWave3Fields() {
  const parsed = PolicySchema.parse({});
  assert.equal(parsed.allow_secret_injection, true);
  assert.deepEqual(parsed.budgets, { ...DEFAULT_BUDGETS });
  assert.ok(DEFAULT_REQUIRE_CONFIRMATION.includes('restore_snapshot'));
  assert.ok(parsed.require_confirmation.includes('restore_snapshot'));
}

function testControlUiUrl() {
  assert.equal(CONTROL_UI_URL, 'http://127.0.0.1:9150');
}

testSetListDeleteRoundTrip();
await testRunSecretCommandWithInjectedReader();
testValidateSecretName();
testPolicySchemaWave3Fields();
testControlUiUrl();
console.log('All secrets tests passed.');
