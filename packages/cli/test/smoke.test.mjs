/**
 * Unit tests for deckagent smoke (Wave 5.2).
 * No network. Uses injected fetch/read hooks. Run via: npm test
 */
import assert from 'node:assert/strict';
import { runSmokeCommand, runSmokeMatrix } from '../dist/smoke.js';

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

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' }
  });
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

function successFetch(calls = []) {
  return async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(String(input), 'https://deckagent.example.workers.dev/mcp');
    assert.equal(init.headers.Authorization, `Bearer ${'a'.repeat(32)}`);
    const body = JSON.parse(init.body);
    switch (body.method) {
      case 'initialize':
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'DeckAgent', version: 'test-worker' }
          }
        });
      case 'tools/list':
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: Array.from({ length: 18 }, (_, index) => ({
              name: index === 0 ? 'get_environment' : `tool_${index}`
            }))
          }
        });
      case 'resources/list':
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            resources: [{ uri: 'deckagent://about', name: 'About DeckAgent' }]
          }
        });
      case 'resources/read':
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            contents: [{ uri: body.params.uri, mimeType: 'text/markdown', text: '# DeckAgent' }]
          }
        });
      case 'prompts/list':
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            prompts: [{ name: 'deckagent_system' }]
          }
        });
      case 'tools/call':
        if (body.params.name === 'get_environment') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: '{}' }] }
          });
        }
        if (body.params.name === 'list_directory') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: '[]' }] }
          });
        }
        break;
      default:
        break;
    }
    return jsonResponse(
      { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not found' } },
      { status: 404 }
    );
  };
}

async function testSmokeCommandPassesWithConfigDefaults() {
  const calls = [];
  const output = outputCapture();
  const code = await runSmokeCommand(['--profile', 'cursor'], {
    readConfig: () => baseConfig(),
    readPolicy: () => ({
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
      disable_builtin_protections: false
    }),
    fetch: successFetch(calls),
    output,
    daemonLikelyOnline: true
  });
  assert.equal(code, 0);
  assert.match(output.lines.join('\n'), /Smoke PASS/);
  assert.equal(calls.some((call) => call.init.headers['X-DeckAgent-Device-Id'] === baseConfig().device_id), true);
}

async function testSmokeCommandFailsOnInitializeError() {
  const output = outputCapture();
  const fetchImpl = async (input, init) => {
    assert.equal(String(input), 'https://deckagent.example.workers.dev/mcp');
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: 'bad token' }
        },
        { status: 401 }
      );
    }
    return successFetch()(input, init);
  };

  const code = await runSmokeCommand(['--profile', 'mcpplayground'], {
    readConfig: () => baseConfig(),
    fetch: fetchImpl,
    output,
    daemonLikelyOnline: false
  });
  assert.equal(code, 1);
  assert.match(output.errors.join('\n'), /Smoke FAIL/);
  const text = [...output.lines, ...output.errors].join('\n');
  assert.match(text, /== DeckAgent MCP Smoke ==/);
  assert.match(text, /== Profile: mcpplayground ==/);
  assert.match(text, /Hint: The Worker \/mcp endpoint must accept/);
  assert.match(text, /Next: deckagent token rotate --deploy/);
}

async function testSmokeMatrixSkipsDaemonCallsWhenOffline() {
  const report = await runSmokeMatrix({
    baseUrl: 'https://deckagent.example.workers.dev',
    token: 'a'.repeat(32),
    profiles: ['claude-desktop'],
    fetch: successFetch(),
    config: baseConfig(),
    daemonLikelyOnline: false
  });
  assert.equal(report.ok, true);
  assert.equal(report.skipped.length, 2);
  assert.equal(report.failed.length, 0);
}

await testSmokeCommandPassesWithConfigDefaults();
await testSmokeCommandFailsOnInitializeError();
await testSmokeMatrixSkipsDaemonCallsWhenOffline();
console.log('All smoke tests passed.');
