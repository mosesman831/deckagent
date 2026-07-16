#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const buildOrder = [
  'packages/mcp-server',
  'packages/cloudflare-worker',
  'packages/desktop-daemon',
  'packages/cli'
];

const packOrder = [
  { name: '@deckagent/mcp-server', workspace: 'packages/mcp-server' },
  { name: '@deckagent/desktop-daemon', workspace: 'packages/desktop-daemon' },
  { name: '@deckagent/cli', workspace: 'packages/cli' }
];

const env = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_fund: 'false'
};

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? root;
  const capture = options.capture ?? false;
  console.log(`$ ${formatCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });

  if (capture) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }

  if (result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? 'unknown'}): ${formatCommand(command, args)}`);
  }
  return result.stdout ?? '';
}

function packWorkspace(pkg, packDir) {
  const before = new Set(fs.readdirSync(packDir));
  run('npm', ['pack', `--workspace=${pkg.workspace}`, '--pack-destination', packDir]);
  const created = fs
    .readdirSync(packDir)
    .filter((entry) => entry.endsWith('.tgz') && !before.has(entry));

  if (created.length !== 1) {
    throw new Error(`Expected one tarball for ${pkg.name}, found ${created.length}: ${created.join(', ')}`);
  }

  const tarball = path.join(packDir, created[0]);
  console.log(`Packed ${pkg.name} -> ${tarball}`);
  return tarball;
}

function main() {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-pack-'));
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckagent-install-'));

  console.log(`Pack directory: ${packDir}`);
  console.log(`Install directory: ${installDir}`);

  for (const workspace of buildOrder) {
    run('npm', ['run', 'build', `--workspace=${workspace}`]);
  }

  const tarballs = packOrder.map((pkg) => packWorkspace(pkg, packDir));

  fs.writeFileSync(
    path.join(installDir, 'package.json'),
    `${JSON.stringify({ private: true, name: 'deckagent-pack-smoke' }, null, 2)}\n`
  );

  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: installDir });

  const deckagentBin = path.join(installDir, 'node_modules', '.bin', 'deckagent');
  const help = run(deckagentBin, ['--help'], { cwd: installDir, capture: true });
  if (!help.includes('DeckAgent CLI')) {
    throw new Error('deckagent --help did not print the expected CLI banner.');
  }

  console.log('Pack smoke passed: deckagent --help worked from packed tarballs.');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pack smoke failed: ${message}`);
  process.exit(1);
}
