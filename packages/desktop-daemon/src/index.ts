#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRegistry, type ToolRegistry } from "@deckagent/mcp-server";
import { readConfig, getConfigPath } from "./config.js";
import { readPolicy, getPolicyPath } from "./policy.js";
import { Logger } from "./logger.js";
import { TunnelClient } from "./tunnel-client.js";

const DECK_DIR = join(homedir(), ".deckagent");
const PID_FILE = join(DECK_DIR, "daemon.pid");

function printUsage(): void {
  console.log(`Usage: deckagent-daemon [options]

Options:
  --foreground    Run in foreground (log to stdout/stderr)
  --stop          Stop a running daemon
  --status        Check daemon status
  --help          Show this help
`);
}

function writePid(): void {
  if (!existsSync(DECK_DIR)) {
    mkdirSync(DECK_DIR, { recursive: true });
  }
  writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
}

function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Ignore.
  }
}

function readPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number(raw);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopDaemon(): void {
  const pid = readPid();
  if (!pid) {
    console.log("No daemon PID file found.");
    process.exit(0);
  }

  if (!isProcessAlive(pid)) {
    console.log(`Daemon PID ${pid} is not running.`);
    removePid();
    process.exit(0);
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon PID ${pid}.`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  process.exit(0);
}

function checkStatus(): void {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    console.log("Daemon: not running");
    if (pid) removePid();
    process.exit(0);
  }

  console.log(`Daemon: running (PID ${pid})`);
  console.log(`Config: ${getConfigPath()}`);
  console.log(`Policy: ${getPolicyPath()}`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  if (args.includes("--stop")) {
    stopDaemon();
    return;
  }

  if (args.includes("--status")) {
    checkStatus();
    return;
  }

  const foreground = args.includes("--foreground");

  if (!foreground) {
    // For v1, the daemon primarily runs in foreground mode. Background mode is
    // intentionally minimal; the CLI or service manager should wrap it.
    // We simply continue in-process, but do not detach.
  }

  let config;
  try {
    config = readConfig();
  } catch (err) {
    console.error(`Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let policy;
  try {
    policy = readPolicy();
  } catch (err) {
    console.error(`Failed to read policy: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!existsSync(DECK_DIR)) {
    mkdirSync(DECK_DIR, { recursive: true });
  }

  const logger = new Logger(config.log_level, foreground);
  writePid();

  let toolRegistry: ToolRegistry;
  try {
    toolRegistry = createRegistry();
  } catch (err) {
    logger.error(`Failed to create tool registry: ${err instanceof Error ? err.message : String(err)}`);
    removePid();
    process.exit(1);
  }

  const client = new TunnelClient(config, toolRegistry, policy, logger);

  function shutdown(signal: string): void {
    logger.info(`Received ${signal}; shutting down gracefully`);
    client.disconnect();
    logger.shutdown();
    removePid();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (process.platform !== "win32") {
    process.on("SIGUSR1", () => {
      logger.info("Received SIGUSR1; rotating logs");
      logger.rotate();
    });
  }

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    writeCrashLog(err);
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
  });

  if (config.auto_connect) {
    client.connect();
  }

  logger.info("Daemon started");
}

function writeCrashLog(err: Error): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const crashPath = join(DECK_DIR, `crash-${timestamp}.log`);
  try {
    writeFileSync(crashPath, `${err.stack || err.message}\n`, { mode: 0o600 });
  } catch {
    // Best effort.
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
