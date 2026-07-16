/**
 * Unit tests for deckagent onboard (Wave 5.1).
 * No network. Uses temp config state and injected fetch. Run via: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectOnboardReport, runOnboardCommand } from '../dist/onboard.js';

const nowIso = '2026-01-01T00:00:00.000Z';

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
    workspace: {
      root: '/tmp/deckagent-test',
      name: 'deckagent-test',
      allow_outside_with_confirmation: true
    },
    ...overrides
  };
}

function basePolicy(overrides = {}) {
  return {
    version: 2,
    profile: 'strict',
    profile_locked: false,
    allowed_directories: ['/tmp/deckagent-test'],
    trusted_directories: ['/tmp/deckagent-test'],
    denied_directories: [],
    protected_paths: [],
    protected_path_policy: 'deny_all',
    path_rules: { symlink_mode: 'deny_escape', allow_dotdot: false },
    trusted_read_directories: [],
    trusted_write_directories: [],
    blocked_commands: [],
    require_confirmation: [],
    read_only: false,
    read_only_mode: 'fs_read',
    allow_browser: false,
    allow_terminal: false,
    allow_computer_use: false,
    allow_plugins: false,
    require_plugin_integrity: true,
    command_mode: 'allowlist',
    allowed_commands: [],
    terminal_mode: 'off',
    network: { allow_browser_hosts: [], deny_browser_hosts: ['*'], block_shell_net_tools: true },
    max_file_read_size: 1024,
    max_command_timeout: 60,
    allow_secret_injection: false,
    budgets: {
      max_tool_calls_per_hour: 300,
      max_shell_seconds_per_hour: 600,
      max_bytes_written_per_hour: 50000000,
      max_confirmations_per_hour: 60
    },
    disable_builtin_protections: false,
    ...overrides
  };
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-onboard-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function writeHealthyState(baseDir, options = {}) {
  writeJson(path.join(baseDir, 'config.json'), baseConfig(options.config ?? {}));
  writeJson(path.join(baseDir, 'policy.json'), basePolicy(options.policy ?? {}));
  fs.writeFileSync(path.join(baseDir, 'daemon.pid'), `${process.pid}\n`);
  writeJson(path.join(baseDir, 'health.json'), {
    ok: true,
    pid: process.pid,
    device_id: '11111111-1111-4111-8111-111111111111',
    tunnel: 'connected',
    last_heartbeat_at: options.lastHeartbeatAt ?? nowIso,
    worker_url: 'https://deckagent.example.workers.dev',
    version: 'test-daemon'
  });
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function onboardFetch(calls = [], options = {}) {
  return async (input, init) => {
    const url = String(input);
    calls.push({ input: url, init });
    if (url.endsWith('/health')) {
      return jsonResponse(
        options.healthOk === false ? { status: 'error' } : { status: 'ok' },
        { status: options.healthOk === false ? 500 : 200 }
      );
    }

    assert.equal(url, 'https://deckagent.example.workers.dev/mcp');
    assert.equal(init.headers.Authorization, `Bearer ${'a'.repeat(32)}`);
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'DeckAgent', version: 'test-worker' }
        }
      });
    }
    if (body.method === 'tools/list') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: Array.from({ length: 18 }, (_, index) => ({
            name: index === 0 ? 'get_environment' : `tool_${index}`
          }))
        }
      });
    }
    if (body.method === 'resources/list') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { resources: [{ uri: 'deckagent://about' }] }
      });
    }
    if (body.method === 'resources/read') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { contents: [{ uri: body.params.uri, text: '# DeckAgent', mimeType: 'text/markdown' }] }
      });
    }
    if (body.method === 'prompts/list') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { prompts: [{ name: 'deckagent_system' }] }
      });
    }
    if (body.method === 'tools/call') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: '{}' }] }
      });
    }
    return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not found' } }, { status: 404 });
  };
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

async function testOnboardPassesWithSkipSmoke() {
  await withTempDir(async (baseDir) => {
    writeHealthyState(baseDir);
    const output = outputCapture();
    const calls = [];
    const code = await runOnboardCommand(['--skip-smoke'], {
      baseDir,
      fetch: onboardFetch(calls),
      now: () => Date.parse(nowIso),
      output
    });
    assert.equal(code, 0);
    assert.match(output.lines.join('\n'), /Onboard PASS/);
    assert.equal(calls.length, 2);
  });
}

async function testOnboardWarnsButDoesNotFailOnEmptyTrustedDirectories() {
  await withTempDir(async (baseDir) => {
    writeHealthyState(baseDir, {
      policy: {
        trusted_directories: [],
        allowed_directories: []
      }
    });
    const report = await collectOnboardReport({
      baseDir,
      fetch: onboardFetch(),
      now: () => Date.parse(nowIso),
      skipSmoke: true
    });
    assert.equal(report.ok, true);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0].detail, /trusted_directories is empty/);
  });
}

async function testOnboardFailsOnWorkerHealth() {
  await withTempDir(async (baseDir) => {
    writeHealthyState(baseDir);
    const output = outputCapture();
    const code = await runOnboardCommand(['--skip-smoke', '--json'], {
      baseDir,
      fetch: onboardFetch([], { healthOk: false }),
      now: () => Date.parse(nowIso),
      output
    });
    assert.equal(code, 1);
    const payload = JSON.parse(output.lines[0]);
    assert.equal(payload.ok, false);
    assert.equal(payload.failed.some((check) => check.id === 'worker_health'), true);
  });
}

async function testOnboardRunsCompactSmoke() {
  await withTempDir(async (baseDir) => {
    writeHealthyState(baseDir);
    const output = outputCapture();
    const code = await runOnboardCommand([], {
      baseDir,
      fetch: onboardFetch(),
      now: () => Date.parse(nowIso),
      output
    });
    assert.equal(code, 0);
    assert.match(output.lines.join('\n'), /Compact MCP smoke/);
  });
}

async function testOnboardHumanOutputShowsSectionsAndFailureHints() {
  await withTempDir(async (baseDir) => {
    writeHealthyState(baseDir);
    const output = outputCapture();
    const code = await runOnboardCommand(['--skip-smoke'], {
      baseDir,
      fetch: onboardFetch([], { healthOk: false }),
      now: () => Date.parse(nowIso),
      output
    });
    assert.equal(code, 1);
    const text = [...output.lines, ...output.errors].join('\n');
    assert.match(text, /== DeckAgent Onboard ==/);
    assert.match(text, /== Readiness checks ==/);
    assert.match(text, /Hint: The Worker \/health endpoint should answer/);
    assert.match(text, /Next: deckagent setup/);
    assert.match(text, /== Next commands ==/);
  });
}

await testOnboardPassesWithSkipSmoke();
await testOnboardWarnsButDoesNotFailOnEmptyTrustedDirectories();
await testOnboardFailsOnWorkerHealth();
await testOnboardRunsCompactSmoke();
await testOnboardHumanOutputShowsSectionsAndFailureHints();
console.log('All onboard tests passed.');
