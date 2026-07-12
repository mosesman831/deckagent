import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger, formatTimestamp } from '../src/logger.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-log-'));
}

test('formatTimestamp produces YYYY-MM-DD HH:mm:ss', () => {
  const stamp = formatTimestamp(new Date(2026, 6, 12, 9, 5, 3));
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(stamp, '2026-07-12 09:05:03');
});

test('logger writes formatted lines and respects level filtering', () => {
  const dir = tempDir();
  const logger = new Logger({ dir, level: 'info' });
  logger.debug('should be filtered out');
  logger.info('hello world');
  logger.error('boom');

  const contents = fs.readFileSync(path.join(dir, 'deckagent.log'), 'utf8');
  assert.doesNotMatch(contents, /should be filtered out/);
  assert.match(contents, /\[INFO\] hello world/);
  assert.match(contents, /\[ERROR\] boom/);
  assert.match(contents, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[INFO\]/m);
});

test('logger rotates at the size cap and keeps a bounded number of files', () => {
  const dir = tempDir();
  // Tiny cap + 3 rotated files so we can exercise rotation quickly.
  const logger = new Logger({ dir, level: 'info', maxBytes: 200, maxFiles: 3 });

  for (let i = 0; i < 50; i++) {
    logger.info(`line number ${i} ` + 'x'.repeat(40));
  }

  assert.ok(fs.existsSync(path.join(dir, 'deckagent.log')), 'current log exists');
  assert.ok(fs.existsSync(path.join(dir, 'deckagent-1.log')), 'first rotated log exists');

  // Never keep more than maxFiles rotated logs.
  assert.equal(fs.existsSync(path.join(dir, 'deckagent-4.log')), false);

  // Current log stays under the cap after rotation.
  const currentSize = fs.statSync(path.join(dir, 'deckagent.log')).size;
  assert.ok(currentSize <= 200, `current log ${currentSize} within cap`);
});
