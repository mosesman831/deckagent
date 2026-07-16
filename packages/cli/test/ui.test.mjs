import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildControlUiUrl,
  getControlUiTokenPath,
  readControlUiToken
} from '../dist/ui.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-cli-ui-'));
try {
  const token = 'a'.repeat(64);
  const tokenPath = getControlUiTokenPath(dir);
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });

  assert.equal(readControlUiToken(dir), token);
  assert.equal(tokenPath, path.join(dir, 'ui.token'));

  const url = buildControlUiUrl({
    baseUrl: 'http://127.0.0.1:9150',
    baseDir: dir
  });
  assert.equal(url, `http://127.0.0.1:9150/?token=${token}`);

  fs.writeFileSync(tokenPath, 'short\n');
  assert.throws(
    () => readControlUiToken(dir),
    /invalid/,
    'invalid token has a human-readable error'
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('All UI tests passed.');
