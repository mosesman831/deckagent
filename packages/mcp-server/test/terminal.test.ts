import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { ToolError } from '../src/index.js';
import { makeSandbox, cleanup, responseText } from './helpers.js';

test('execute_command runs echo', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const res = await registry.execute('execute_command', { command: 'echo hello' });
    assert.match(responseText(res), /hello/);
    assert.notEqual(res.isError, true);
  } finally {
    await cleanup(dir);
  }
});

test('execute_command reports non-zero exit as isError', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const res = await registry.execute('execute_command', { command: 'exit 3' });
    assert.equal(res.isError, true);
  } finally {
    await cleanup(dir);
  }
});

test('execute_command times out', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    await assert.rejects(
      () => registry.execute('execute_command', { command: 'sleep 5', timeout: 1 }),
      (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal((err as ToolError).code, 'TOOL_TIMEOUT');
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test('execute_command_stream collects output', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const res = await registry.execute('execute_command_stream', { command: 'echo streamed-output' });
    assert.match(responseText(res), /streamed-output/);
  } finally {
    await cleanup(dir);
  }
});

test('list_processes returns process listing', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const res = await registry.execute('list_processes', {});
    assert.ok(responseText(res).length > 0);
  } finally {
    await cleanup(dir);
  }
});

test('list_processes filters by substring', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const res = await registry.execute('list_processes', { filter: 'node' });
    // The current test runner is a node process, so it should appear.
    assert.match(responseText(res).toLowerCase(), /node/);
  } finally {
    await cleanup(dir);
  }
});

test('kill_process terminates a spawned sleep', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const child = spawn('sleep', ['30']);
    assert.ok(child.pid, 'child should have a pid');
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await registry.execute('kill_process', { pid: child.pid as number });
    await exited;
    assert.equal(child.killed || child.exitCode !== null || child.signalCode !== null, true);
  } finally {
    await cleanup(dir);
  }
});

test('kill_process on nonexistent pid throws', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    await assert.rejects(
      () => registry.execute('kill_process', { pid: 2147483646 }),
      (err) => {
        assert.ok(err instanceof ToolError);
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});
