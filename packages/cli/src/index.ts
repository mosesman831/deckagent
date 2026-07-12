#!/usr/bin/env node
import { Command } from "commander";
import { setup } from "./setup.js";
import { deployCommand } from "./deploy.js";
import { registerDevice } from "./device.js";
import { daemonCommand, installDaemon, runForeground, tailLogs, uninstallDaemon } from "./daemon.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("deckagent").description("Self-hosted MCP bridge setup and lifecycle CLI").version("1.0.0");
  program.command("setup").option("--worker-name <name>", "Cloudflare Worker name", "deckagent").option("--device-name <name>", "device name").option("--github-client-id <id>").option("--github-client-secret <secret>").option("--account-id <id>").option("--yes", "use non-interactive defaults").action(async (options: { workerName: string; deviceName?: string; githubClientId?: string; githubClientSecret?: string; accountId?: string; yes?: boolean }) => setup({ ...options, deviceName: options.deviceName ?? "", workerName: options.workerName }));
  program.command("deploy").action(deployCommand);
  program.command("register").option("--deploy-secret <secret>").option("--device-name <name>").action(async (options: { deploySecret?: string; deviceName?: string }) => { await registerDevice(options); });
  const daemon = program.command("daemon").description("Manage the desktop daemon");
  daemon.option("--foreground", "run directly in the foreground").argument("[action]", "start, stop, status, or restart", "status").action(async (action: string, options: { foreground?: boolean }) => options.foreground ? runForeground() : daemonCommand(action as "start" | "stop" | "status" | "restart"));
  daemon.command("start").action(() => daemonCommand("start"));
  daemon.command("stop").action(() => daemonCommand("stop"));
  daemon.command("status").action(() => daemonCommand("status"));
  daemon.command("restart").action(() => daemonCommand("restart"));
  program.command("install").action(installDaemon);
  program.command("logs").action(tailLogs);
  program.command("uninstall").option("--yes", "remove config without prompting").action(async (options: { yes?: boolean }) => uninstallDaemon(Boolean(options.yes)));
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try { await createProgram().parseAsync(argv); } catch (error) { console.error(error instanceof Error ? error.message : "DeckAgent command failed"); process.exitCode = 1; }
}

if (process.argv[1]?.endsWith("/index.js")) await main();
