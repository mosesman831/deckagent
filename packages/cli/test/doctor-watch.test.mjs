/**
 * Unit tests for doctor --watch health failure behavior (F10).
 * No network. Uses temp baseDir and fake time. Run via: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDoctorResults, runDoctorWatch } from '../dist/doctor.js';

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-doctor-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeBaseFiles(baseDir) {
  fs.writeFileSync(
    path.join(baseDir, 'config.json'),
    JSON.stringify(
      {
        device_id: '11111111-1111-4111-8111-111111111111',
        token: 't'.repeat(32),
        worker_url: 'https://example.workers.dev',
        device_name: 'test-device',
        api_token: 'a'.repeat(32),
        heartbeat_interval: 15,
        tool_timeout: 60,
        auto_connect: true,
        log_level: 'info'
      },
      null,
      2
    ) + '\n'
  );
  fs.writeFileSync(path.join(baseDir, 'policy.json'), '{}\n');
  fs.writeFileSync(path.join(baseDir, 'daemon.pid'), `${process.pid}\n`);
}

function writeHealth(baseDir, lastHeartbeatAt, extra = {}) {
  fs.writeFileSync(
    path.join(baseDir, 'health.json'),
    JSON.stringify(
      {
        ok: true,
        pid: process.pid,
        device_id: '11111111-1111-4111-8111-111111111111',
        tunnel: 'connected',
        last_heartbeat_at: lastHeartbeatAt,
        worker_url: 'https://example.workers.dev',
        version: 'test-version',
        ...extra
      },
      null,
      2
    ) + '\n'
  );
}

await withTempDir(async (baseDir) => {
  writeBaseFiles(baseDir);

  const report = await collectDoctorResults({
    baseDir,
    intervalSeconds: 0.01,
    now: () => Date.parse('2026-01-01T00:00:00.000Z')
  });
  const healthCheck = report.checks.find((check) => check.label === 'daemon health');
  assert.ok(healthCheck, 'daemon health check exists');
  assert.equal(healthCheck.ok, false);
  assert.match(healthCheck.message, /not found/);
});

await withTempDir(async (baseDir) => {
  writeBaseFiles(baseDir);
  writeHealth(baseDir, '2026-01-01T00:00:00.000Z');

  let now = Date.parse('2026-01-01T00:01:00.000Z');
  const output = {
    lines: [],
    errors: [],
    log(message) {
      this.lines.push(message);
    },
    error(message) {
      this.errors.push(message);
    }
  };

  const code = await runDoctorWatch({
    baseDir,
    intervalSeconds: 0.01,
    failAfterSeconds: 0.02,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    output,
    exitOnSigint: false
  });

  assert.equal(code, 1);
  assert.ok(output.lines.length >= 2, 'watch emitted status lines');
  assert.match(output.lines.at(-1), /unhealthy/);
  assert.match(output.lines.at(-1), /heartbeat=60\.0s stale/);
  assert.match(output.errors.at(-1), /unhealthy for 0\.02s/);
});

await withTempDir(async (baseDir) => {
  writeBaseFiles(baseDir);
  writeHealth(baseDir, '2026-01-01T00:00:00.000Z', {
    worker_version: 'worker-1.2.3',
    protocol_warning: 'upgrade_daemon'
  });

  const report = await collectDoctorResults({
    baseDir,
    intervalSeconds: 60,
    now: () => Date.parse('2026-01-01T00:00:01.000Z')
  });
  const compatibility = report.checks.find((check) => check.label === 'Worker compatibility');
  assert.ok(compatibility, 'Worker compatibility check exists');
  assert.equal(compatibility.ok, false);
  assert.match(compatibility.message, /worker=worker-1\.2\.3/);
  assert.match(compatibility.message, /upgrade_daemon/);
});

console.log('All doctor watch tests passed.');
