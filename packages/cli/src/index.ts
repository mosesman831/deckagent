#!/usr/bin/env node
import { Command } from "commander";
import { runDeploy } from "./deploy.js";
import { registerDevice } from "./device.js";
import { runSetup } from "./setup.js";
import {
  installService,
  restartDaemon,
  runForeground,
  startDaemon,
  statusDaemon,
  stopDaemon,
  tailLogs,
  uninstall,
} from "./daemon.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("deckagent")
    .description("DeckAgent: self-hosted MCP bridge CLI")
    .version("1.0.0");

  program
    .command("setup")
    .description("One-command setup: deploy worker, register device, install + start daemon")
    .option("--worker-name <name>", "Cloudflare Worker name", "deckagent")
    .option("--device-name <name>", "Device name (defaults to hostname)")
    .option("--github-client-id <id>", "GitHub OAuth App client id")
    .option("--github-client-secret <secret>", "GitHub OAuth App client secret")
    .option("--account-id <id>", "Cloudflare account id")
    .option("-y, --yes", "Non-interactive: accept defaults, no prompts", false)
    .action(async (opts) => {
      await runSetup({
        workerName: opts.workerName,
        deviceName: opts.deviceName,
        githubClientId: opts.githubClientId,
        githubClientSecret: opts.githubClientSecret,
        accountId: opts.accountId,
        yes: opts.yes,
      });
    });

  program
    .command("deploy")
    .description("Deploy the Cloudflare Worker only")
    .action(async () => {
      runDeploy();
    });

  program
    .command("register")
    .description("Register this device with the Worker only")
    .option("--device-name <name>", "Device name (defaults to hostname)")
    .option("--deploy-secret <secret>", "Deploy secret for the /api/devices endpoint")
    .option("--worker-url <url>", "Worker URL (defaults to config)")
    .option("-y, --yes", "Non-interactive", false)
    .action(async (opts) => {
      await registerDevice({
        deviceName: opts.deviceName,
        deploySecret: opts.deploySecret,
        workerUrl: opts.workerUrl,
        yes: opts.yes,
      });
    });

  program
    .command("install")
    .description("Install the daemon as a user LaunchAgent/systemd service only")
    .action(() => {
      installService();
    });

  program
    .command("daemon")
    .description("Daemon lifecycle: start | stop | status | restart")
    .argument("[action]", "start | stop | status | restart", "status")
    .option("--foreground", "Run the daemon in the foreground (no service)", false)
    .action((action: string, opts: { foreground: boolean }) => {
      if (opts.foreground) {
        runForeground();
        return;
      }
      switch (action) {
        case "start":
          startDaemon();
          break;
        case "stop":
          stopDaemon();
          break;
        case "restart":
          restartDaemon();
          break;
        case "status":
          statusDaemon();
          break;
        default:
          console.error(`Unknown daemon action: ${action}`);
          process.exitCode = 1;
      }
    });

  program
    .command("logs")
    .description("Tail the daemon log")
    .option("-n, --lines <n>", "Number of lines to show", "200")
    .action((opts: { lines: string }) => {
      tailLogs(undefined, Number.parseInt(opts.lines, 10) || 200);
    });

  program
    .command("uninstall")
    .description("Stop daemon, remove service, optionally remove config")
    .option("-y, --yes", "Also remove ~/.deckagent config", false)
    .action((opts: { yes: boolean }) => {
      uninstall(undefined, opts.yes);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
