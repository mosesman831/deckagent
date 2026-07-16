/**
 * Unit tests for doctor --json / --strict (Wave 6.5).
 * Uses temp baseDir state and captured output. Run via: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../dist/doctor.js';

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-doctor-json-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function outputCapture() {
  return {
    lines: [],
    errors: [],
    log(message) {
      this.lines.push(message);
    },
    error(message) {
      this.errors.push(message);
    }
  };
}

await withTempDir(async (baseDir) => {
  const output = outputCapture();
  const code = await runDoctor(['--json', '--strict'], { baseDir, output });
  assert.equal(code, 1);
  assert.equal(output.errors.length, 0);

  const payload = JSON.parse(output.lines.join('\n'));
  assert.equal(payload.ok, false);
  assert.ok(Array.isArray(payload.checks), 'checks array is emitted');
  assert.ok(payload.checks.length > 0, 'checks array is not empty');
  assert.equal(payload.failed.some((check) => check.remediation), true);

  const configCheck = payload.checks.find((check) => check.label === 'config.json');
  assert.ok(configCheck, 'config.json check exists');
  assert.equal(configCheck.ok, false);
  assert.match(configCheck.remediation, /deckagent setup/);
});

await withTempDir(async (baseDir) => {
  const output = outputCapture();
  const code = await runDoctor(['--json'], { baseDir, output });
  assert.equal(code, 0);
  const payload = JSON.parse(output.lines.join('\n'));
  assert.equal(payload.ok, false);
});

console.log('All doctor json tests passed.');
