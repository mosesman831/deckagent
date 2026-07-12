import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, cleanup, responseText } from './helpers.js';

test('get_environment returns system info', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const res = await registry.execute('get_environment', {});
    const parsed = JSON.parse(responseText(res));
    assert.equal(typeof parsed.os, 'string');
    assert.equal(typeof parsed.arch, 'string');
    assert.equal(typeof parsed.platform, 'string');
    assert.equal(typeof parsed.hostname, 'string');
    assert.equal(typeof parsed.home_dir, 'string');
    assert.equal(typeof parsed.shell, 'string');
    assert.equal(typeof parsed.cpu_count, 'number');
    assert.equal(typeof parsed.memory_gb, 'number');
    assert.ok(parsed.cpu_count >= 1);
  } finally {
    await cleanup(dir);
  }
});
