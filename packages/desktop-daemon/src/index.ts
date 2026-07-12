#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, getConfigDir, ensureConfigDir } from './config.js';
import { loadPolicy } from './policy.js';
import { initLogger, formatTimestamp } from './logger.js';
import { ToolExecutor } from './tool-executor.js';
import { TunnelClient } from './tunnel-client.js';

function getPidPath(): string {
  return path.join(os.homedir(), '.deckagent', 'daemon.pid');
}

function writePidFile(): void {
  ensureConfigDir();
  fs.writeFileSync(getPidPath(), String(process.pid), 'utf8');
}

function removePidFile(): void {
  try {
    fs.rmSync(getPidPath(), { force: true });
  } catch {
    /* ignore */
  }
}

function writeCrashLog(err: unknown): void {
  try {
    ensureConfigDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(getConfigDir(), `crash-${stamp}.log`);
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    fs.writeFileSync(file, `${formatTimestamp(new Date())} CRASH\n${detail}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

async function main(): Promise<void> {
  const foreground = process.argv.includes('--foreground');

  // 1-2. Load and validate config.
  const config = loadConfig();

  // 3. Load policy.
  const policy = loadPolicy();

  // 4. Initialize logger (also mirrors to stdout in foreground mode).
  const logger = initLogger({
    dir: path.join(getConfigDir(), 'logs'),
    level: config.log_level,
    console: foreground,
  });
  logger.info(`DeckAgent daemon starting (pid ${process.pid}, device ${config.device_name}).`);
  logger.info(`Mode: ${foreground ? 'foreground' : 'background'}.`);

  // 5. Write PID file.
  writePidFile();

  // 6. Create executor and tunnel client.
  const executor = new ToolExecutor(policy);
  const tunnel = new TunnelClient(config, policy, executor);

  // 7. Auto-connect unless disabled.
  if (config.auto_connect) {
    tunnel.connect();
  } else {
    logger.info('auto_connect is false; not connecting. Waiting idle.');
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down.`);
    tunnel.disconnect();
    removePidFile();
    // Give the disconnect frame a brief moment to flush.
    setTimeout(() => process.exit(0), 100);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    writeCrashLog(err);
    try {
      logger.error(`Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      /* ignore */
    }
    removePidFile();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    writeCrashLog(reason);
    try {
      logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    } catch {
      /* ignore */
    }
    removePidFile();
    process.exit(1);
  });

  // Keep the process alive.
  logger.info('DeckAgent daemon running.');
}

main().catch((err) => {
  writeCrashLog(err);
  process.stderr.write(`DeckAgent daemon failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  removePidFile();
  process.exit(1);
});
