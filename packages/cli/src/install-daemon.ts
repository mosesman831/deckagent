import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { getConfigDir, getLogDir } from './configure.js';
import { getCliPackageRoot, getDaemonPackageCandidates } from './paths.js';

const WINDOWS_TASK_NAME = 'DeckAgentDaemon';

const MISSING_DAEMON_HINT =
  'Desktop daemon package not found. Run deckagent from the DeckAgent monorepo, or install @deckagent/desktop-daemon (a dependency of @deckagent/cli) so the daemon entry is resolvable.';

export interface DaemonPaths {
  packageDir: string;
  distFile: string;
}

export interface ResolveDaemonOptions {
  /** Override CLI package root (directory containing package.json). */
  cliPackageRoot?: string;
}

function daemonDistFile(packageDir: string): string {
  return path.join(packageDir, 'dist', 'src', 'index.js');
}

function tryResolveInstalledDaemon(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve('@deckagent/desktop-daemon/package.json');
    return path.dirname(pkgJsonPath);
  } catch {
    // fall through
  }

  try {
    if (typeof import.meta.resolve === 'function') {
      const resolved = import.meta.resolve('@deckagent/desktop-daemon/package.json');
      const pkgJsonPath = resolved.startsWith('file:')
        ? fileURLToPath(resolved)
        : resolved;
      return path.dirname(pkgJsonPath);
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Resolve desktop-daemon paths.
 * Order: monorepo sibling → installed @deckagent/desktop-daemon (createRequire) → error.
 */
export function resolveDaemonPaths(options: ResolveDaemonOptions = {}): DaemonPaths {
  const cliPackageRoot = options.cliPackageRoot ?? getCliPackageRoot();
  const tried: string[] = [];

  for (const packageDir of getDaemonPackageCandidates(cliPackageRoot)) {
    tried.push(packageDir);
    if (fs.existsSync(packageDir)) {
      return { packageDir, distFile: daemonDistFile(packageDir) };
    }
  }

  const installedDir = tryResolveInstalledDaemon();
  if (installedDir) {
    tried.push(installedDir);
    if (fs.existsSync(installedDir)) {
      return { packageDir: installedDir, distFile: daemonDistFile(installedDir) };
    }
  } else {
    tried.push('@deckagent/desktop-daemon (npm dependency)');
  }

  throw new Error(
    `${MISSING_DAEMON_HINT}\nLooked for:\n${tried.map((p) => `  - ${p}`).join('\n')}`
  );
}

export function getPidFile(): string {
  return path.join(getConfigDir(), 'daemon.pid');
}

export function getNodeBinary(): string {
  return process.execPath;
}

export function isInstalled(): boolean {
  try {
    const { distFile } = resolveDaemonPaths();
    return fs.existsSync(distFile);
  } catch {
    return false;
  }
}

export async function installPrerequisites(): Promise<void> {
  const { packageDir, distFile } = resolveDaemonPaths();
  const isMonorepoSibling = path.basename(path.dirname(packageDir)) === 'packages';

  // Published npm package already ships dist/; skip rebuild unless monorepo sibling.
  if (!isMonorepoSibling && fs.existsSync(distFile)) {
    console.log(`Using installed daemon at ${packageDir}`);
    return;
  }

  console.log('Installing daemon dependencies...');
  execSync('npm install', { cwd: packageDir, stdio: 'inherit' });

  console.log('Building daemon...');
  execSync('npm run build', { cwd: packageDir, stdio: 'inherit' });
}

export function createLaunchAgent(config: { daemonDistFile: string; nodeBinary: string }): void {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deckagent.daemon.plist');
  const logDir = getLogDir();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.deckagent.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${config.nodeBinary}</string>
    <string>${config.daemonDistFile}</string>
    <string>--foreground</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'stderr.log')}</string>
</dict>
</plist>`;

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, 'utf-8');
}

export function createSystemdService(config: { daemonDistFile: string; nodeBinary: string }): void {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'deckagent-daemon.service');
  const logDir = getLogDir();

  const service = `[Unit]
Description=DeckAgent Desktop Daemon
After=network.target

[Service]
Type=simple
ExecStart=${config.nodeBinary} ${config.daemonDistFile} --foreground
Restart=always
RestartSec=5
StandardOutput=append:${path.join(logDir, 'stdout.log')}
StandardError=append:${path.join(logDir, 'stderr.log')}

[Install]
WantedBy=default.target
`;

  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(servicePath, service, 'utf-8');
}

/** Escape a path for embedding inside a schtasks /TR command string. */
function quoteForSchtasks(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function createWindowsScheduledTask(config: { daemonDistFile: string; nodeBinary: string }): void {
  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });

  // Start script so schtasks has a single .cmd target with logging.
  const startScript = path.join(getConfigDir(), 'start-daemon.cmd');
  const stdoutLog = path.join(logDir, 'stdout.log');
  const stderrLog = path.join(logDir, 'stderr.log');
  const cmdBody = `@echo off\r\n"${config.nodeBinary}" "${config.daemonDistFile}" --foreground >> "${stdoutLog}" 2>> "${stderrLog}"\r\n`;
  fs.writeFileSync(startScript, cmdBody, 'utf-8');

  const tr = quoteForSchtasks(startScript);
  execSync(
    `schtasks /Create /TN "${WINDOWS_TASK_NAME}" /TR ${tr} /SC ONLOGON /RL LIMITED /F`,
    { stdio: 'inherit' }
  );
}

export function installDaemonService(): void {
  const { distFile } = resolveDaemonPaths();
  if (!fs.existsSync(distFile)) {
    throw new Error(
      `Daemon not built. Missing ${distFile}. Run setup again or build packages/desktop-daemon.`
    );
  }

  const config = { daemonDistFile: distFile, nodeBinary: getNodeBinary() };
  const platform = os.platform();

  if (platform === 'darwin') {
    createLaunchAgent(config);
  } else if (platform === 'linux') {
    createSystemdService(config);
  } else if (platform === 'win32') {
    createWindowsScheduledTask(config);
  } else {
    throw new Error(`Unsupported platform for background service installation: ${platform}`);
  }
}

export function startDaemon(): void {
  const platform = os.platform();
  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deckagent.daemon.plist');
    execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
  } else if (platform === 'linux') {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync('systemctl --user enable deckagent-daemon.service', { stdio: 'inherit' });
    execSync('systemctl --user start deckagent-daemon.service', { stdio: 'inherit' });
  } else if (platform === 'win32') {
    execSync(`schtasks /Run /TN "${WINDOWS_TASK_NAME}"`, { stdio: 'inherit' });
  } else {
    throw new Error(`Unsupported platform for starting background service: ${platform}`);
  }
}

export function stopDaemon(): void {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deckagent.daemon.plist');
      if (fs.existsSync(plistPath)) {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'inherit' });
      }
    } else if (platform === 'linux') {
      execSync('systemctl --user stop deckagent-daemon.service', { stdio: 'inherit' });
    } else if (platform === 'win32') {
      try {
        execSync(`schtasks /End /TN "${WINDOWS_TASK_NAME}"`, { stdio: 'pipe' });
      } catch {
        // Task may not be running.
      }
    }
  } catch {
    // Service may not be loaded.
  }

  const pidFile = getPidFile();
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be gone.
    }
    fs.unlinkSync(pidFile);
  }
}

export function isDaemonRunning(): boolean {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) {
    return false;
  }
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runDaemonForeground(): ChildProcess {
  const { distFile } = resolveDaemonPaths();
  if (!fs.existsSync(distFile)) {
    throw new Error(`Daemon not built. Missing ${distFile}`);
  }

  const child = spawn(getNodeBinary(), [distFile, '--foreground'], {
    stdio: 'inherit',
    detached: false
  });

  child.on('error', (err) => {
    console.error('Failed to start daemon:', err.message);
    process.exit(1);
  });

  return child;
}

export function uninstallDaemonService(): void {
  stopDaemon();
  const platform = os.platform();
  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deckagent.daemon.plist');
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
    }
  } else if (platform === 'linux') {
    try {
      execSync('systemctl --user disable deckagent-daemon.service', { stdio: 'pipe' });
    } catch {
      // May not have been enabled.
    }
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'deckagent-daemon.service');
    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
    }
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    } catch {
      // ignore
    }
  } else if (platform === 'win32') {
    try {
      execSync(`schtasks /Delete /TN "${WINDOWS_TASK_NAME}" /F`, { stdio: 'pipe' });
    } catch {
      // Task may not exist.
    }
    const startScript = path.join(getConfigDir(), 'start-daemon.cmd');
    if (fs.existsSync(startScript)) {
      fs.unlinkSync(startScript);
    }
  }
}

function findLatestLogFile(): { name: string; path: string } | null {
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    return null;
  }

  const files = fs
    .readdirSync(logDir)
    .filter((f) => (f.startsWith('deckagent-') && f.endsWith('.log')) || f === 'stdout.log' || f === 'stderr.log')
    .map((f) => ({ name: f, path: path.join(logDir, f) }))
    .sort((a, b) => fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs);

  // Prefer rotated deckagent-*.log over stdout/stderr helpers when present.
  const rotated = files.find((f) => f.name.startsWith('deckagent-'));
  return rotated ?? files[0] ?? null;
}

function readLastLines(filePath: string, lineCount: number): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  // Drop trailing empty line from final newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.slice(-lineCount).join('\n');
}

export interface TailLogsOptions {
  /** Number of trailing lines to print before following. Default 100. */
  lines?: number;
  /** Follow new lines (like tail -f). Default: true when stdout is a TTY. */
  follow?: boolean;
}

/**
 * Print the last N lines of the latest daemon log, then optionally follow.
 */
export function tailLogs(options: TailLogsOptions = {}): void {
  const lines = options.lines ?? 100;
  const follow = options.follow ?? Boolean(process.stdout.isTTY);

  const latest = findLatestLogFile();
  if (!latest) {
    console.log('No daemon log files found.');
    return;
  }

  console.log(`--- ${latest.name} ---`);
  const initial = readLastLines(latest.path, lines);
  if (initial) {
    console.log(initial);
  }

  if (!follow) {
    return;
  }

  let offset = fs.statSync(latest.path).size;
  console.log('\n(following — Ctrl+C to stop)\n');

  const poll = (): void => {
    try {
      const stat = fs.statSync(latest.path);
      if (stat.size < offset) {
        // File rotated or truncated
        offset = 0;
      }
      if (stat.size > offset) {
        const fd = fs.openSync(latest.path, 'r');
        try {
          const length = stat.size - offset;
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, offset);
          process.stdout.write(buffer.toString('utf-8'));
          offset = stat.size;
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // File may have been removed mid-follow.
    }
  };

  const interval = setInterval(poll, 500);
  const onSignal = (): void => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
