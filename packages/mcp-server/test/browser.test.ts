import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../src/index.js';
import { makeSandbox, cleanup, responseText } from './helpers.js';

/**
 * The browser test must not crash when no Chrome/CDP is available. It either
 * returns a proper ToolResponse (when a browser is reachable) or throws a
 * ToolError with a human-readable message — never an unhandled crash.
 */
test('browser_navigate returns a ToolResponse or throws ToolError', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    let res;
    try {
      res = await registry.execute('browser_navigate', { url: 'about:blank' });
    } catch (err) {
      assert.ok(err instanceof ToolError, `expected ToolError, got ${String(err)}`);
      assert.ok((err as ToolError).message.length > 0);
      return;
    }
    // If a browser was reachable, verify the shape of the response.
    assert.ok(Array.isArray(res.content));
    assert.ok(res.content.length >= 1);
    assert.match(responseText(res), /Title:/);
  } finally {
    // Best-effort close of any launched browser.
    const ctx = registry.getContext();
    await ctx.browserManager.close().catch(() => undefined);
    await cleanup(dir);
  }
});

test('browser_screenshot without a page throws a ToolError', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    await assert.rejects(
      () => registry.execute('browser_screenshot', {}),
      (err) => {
        assert.ok(err instanceof ToolError);
        return true;
      },
    );
  } finally {
    const ctx = registry.getContext();
    await ctx.browserManager.close().catch(() => undefined);
    await cleanup(dir);
  }
});
