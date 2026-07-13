import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfigDir, getLogDir } from './configure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DaemonPaths {
  packageDir: string;
  distFile: string;
}

export function resolveDaemonPaths(): DaemonPaths {
  const packageDir = path.resolve(__dirname, '..', '..', 'desktop-daemon');
  const distFile = path.join(packageDir, 'dist', 'src', 'index.js');
  return { packageDir, distFile };
}

export function getPidFile(): string {
  return path.join(getConfigDir(), 'daemon.pid');
}

export function isInstalled(): boolean {
  const { distFile } = resolveDaemonPaths();
  return fs.existsSync(distFile);
}

export async function installPrerequisites(): Promise<void> {
  const { packageDir } = resolveDaemonPaths();
  if (!fs.existsSync(packageDir)) {
    throw new Error(`Daemon package not found at ${packageDir}`);
  }

  console.log('Installing daemon dependencies...');
  execSync('npm install', { cwd: packageDir, stdio: 'inherit' });

  console.log('Building daemon...');
  execSync('npm run build', { cwd: packageDir, stdio: 'inherit' });
}

export function createLaunchAgent(config: { daemonDistFile: string }): void {
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
    <string>/usr/local/bin/node</string>
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

export function createSystemdService(config: { daemonDistFile: string }): void {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'deckagent-daemon.service');
  const logDir = getLogDir();

  const service = `[Unit]
Description=DeckAgent Desktop Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${config.daemonDistFile} --foreground
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

export function installDaemonService(): void {
  const { distFile } = resolveDaemonPaths();
  const config = { daemonDistFile: distFile };

  const platform = os.platform();
  if (platform === 'darwin') {
    createLaunchAgent(config);
  } else if (platform === 'linux') {
    createSystemdService(config);
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
    execSync('systemctl --user start deckagent-daemon', { stdio: 'inherit' });
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
      execSync('systemctl --user stop deckagent-daemon', { stdio: 'inherit' });
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

  const child = spawn('node', [distFile, '--foreground'], {
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
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'deckagent-daemon.service');
    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
    }
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    } catch {
      // ignore
    }
  }
}

export function tailLogs(): void {
  const logDir = getLogDir();
  const files = fs.readdirSync(logDir)
    .filter((f) => f.startsWith('deckagent-') && f.endsWith('.log'))
    .map((f) => ({ name: f, path: path.join(logDir, f) }))
    .sort((a, b) => fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs);

  if (files.length === 0) {
    console.log('No daemon log files found.');
    return;
  }

  const latest = files[0].path;
  console.log(`--- ${files[0].name} ---`);
  console.log(fs.readFileSync(latest, 'utf-8'));
}
