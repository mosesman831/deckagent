/**
 * Unit tests for grouped top-level CLI help (Wave 6.5).
 * Runs the built CLI entrypoint. Run via: npm test
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const cliPath = path.resolve('dist/index.js');
const help = execFileSync(process.execPath, [cliPath, 'help'], {
  cwd: path.resolve('.'),
  encoding: 'utf-8',
  env: { ...process.env, NO_COLOR: '1' }
});

for (const heading of ['Setup:', 'Operate:', 'Security:', 'Troubleshoot:', 'Examples:']) {
  assert.match(help, new RegExp(`^${heading}`, 'm'));
}

assert.match(help, /deckagent doctor --strict/);
assert.match(help, /onboard \[--skip-smoke\] \[--json\]/);
assert.match(help, /smoke \[--profile mcpplayground\|cursor\|claude-desktop\]/);

console.log('All CLI help tests passed.');
