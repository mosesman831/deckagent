#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createRegistry,
  setBrowserEnabled,
  setMaxFileReadSize,
  killAllActiveCommands,
  type ToolRegistry,
} from "@deckagent/mcp-server";
import { readConfig, getConfigPath, applyWorkspaceContext } from "./config.js";
import { readPolicy, getPolicyPath, type Policy } from "./policy.js";
import { Logger } from "./logger.js";
import { TunnelClient } from "./tunnel-client.js";
import { ConfirmationServer } from "./confirmation-server.js";
import { LocalTunnelServer } from "./local-server.js";
import { ToolExecutor } from "./tool-executor.js";

const DECK_DIR = join(homedir(), ".deckagent");
const PID_FILE = join(DECK_DIR, "daemon.pid");

function printUsage(): void {
  console.log(`Usage: deckagent-daemon [options]

Options:
  --foreground       Run in foreground (log to stdout/stderr)
  --enable-browser   Enable browser tools for this session (overrides policy.allow_browser)
  --stop             Stop a running daemon
  --status           Check daemon status
  --help             Show this help
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

function applyRuntimePolicy(policy: Policy, enableBrowserFlag: boolean): Policy {
  if (!enableBrowserFlag) return policy;
  return { ...policy, allow_browser: true };
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
  const enableBrowserFlag = args.includes("--enable-browser");

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

  let policy: Policy;
  try {
    policy = applyRuntimePolicy(readPolicy(), enableBrowserFlag);
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

  // Honor browser enable flag / policy in mcp-server.
  try {
    setBrowserEnabled(policy.allow_browser);
    setMaxFileReadSize(policy.max_file_read_size);
  } catch (err) {
    logger.warn(
      `Failed to apply mcp-server runtime settings: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Wave 3 F1: apply workspace context so relative tool paths resolve correctly.
  try {
    applyWorkspaceContext(config.workspace);
    if (config.workspace) {
      logger.info(
        `Workspace active: ${config.workspace.name} (${config.workspace.root})`,
      );
    }
  } catch (err) {
    logger.warn(
      `Failed to apply workspace context: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (policy.allow_browser) {
    logger.info("Browser tools enabled for this session");
  } else {
    logger.info("Browser tools disabled (policy.allow_browser=false; pass --enable-browser to enable)");
  }

  const confirmationServer = new ConfirmationServer(logger);
  const executor = new ToolExecutor({
    toolRegistry,
    policy,
    logger,
    confirmationServer,
    toolTimeoutSeconds: config.tool_timeout,
    workspace: config.workspace ?? null,
  });

  const localServer = new LocalTunnelServer(executor, logger);
  const client = new TunnelClient(config, executor, logger);

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully`);
    client.disconnect();
    executor.abortAll();
    try {
      await killAllActiveCommands();
    } catch {
      // ignore
    }
    try {
      await localServer.stop();
    } catch {
      // ignore
    }
    try {
      await confirmationServer.stop();
    } catch {
      // ignore
    }
    logger.shutdown();
    removePid();
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  if (process.platform !== "win32") {
    process.on("SIGUSR1", () => {
      logger.info("Received SIGUSR1; rotating logs");
      logger.rotate();
    });
  }

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    writeCrashLog(err);
    void shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
  });

  try {
    await confirmationServer.start();
  } catch (err) {
    logger.error(
      `Failed to start confirmation server: ${err instanceof Error ? err.message : String(err)}`,
    );
    removePid();
    process.exit(1);
  }

  try {
    await localServer.start();
  } catch (err) {
    logger.error(
      `Failed to start local tunnel server: ${err instanceof Error ? err.message : String(err)}`,
    );
    await confirmationServer.stop();
    removePid();
    process.exit(1);
  }

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
