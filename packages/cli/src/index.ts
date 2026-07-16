#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from './setup.js';
import {
  runDaemonForeground,
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  installDaemonService,
  tailLogs
} from './install-daemon.js';
import { runDoctor } from './doctor.js';
import { runTunnel } from './tunnel.js';
import { runWorkspaceCommand } from './workspace.js';
import { runSecretCommand } from './secrets.js';
import { runPolicyCommand } from './policy-cmd.js';
import { runDeviceCommand } from './device-cmd.js';
import { openControlUi } from './ui.js';
import { runPluginCommand } from './plugin.js';
import { runUninstall } from './uninstall.js';
import { runTokenCommand } from './token.js';
import { runOnboardCommand } from './onboard.js';
import { runSmokeCommand } from './smoke.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function printHelp(): void {
  console.log(`DeckAgent CLI v${getVersion()}

Usage:
  deckagent <command> [options]

Setup:
  setup                         Run the full setup wizard
  onboard [--skip-smoke] [--json]
                                Verify local setup and connector readiness
  workspace use <path>          Set active workspace (project scope)
  workspace status              Show current workspace
  workspace clear               Clear workspace from config

Operate:
  daemon [--foreground]         Start the desktop daemon (background by default)
  daemon --stop                 Stop the desktop daemon
  daemon --status               Check if the daemon is running
  logs [--follow] [--lines N]   Tail daemon logs (follows on TTY by default)
  ui                            Open local control UI (http://127.0.0.1:9150)
  tunnel [--name NAME] [--url URL]
                                Cloudflare Tunnel to local wrangler (dev)

Security:
  token rotate [--deploy]       Rotate the Worker Bearer API token
  policy show                   Show effective policy
  policy set-profile <strict|dev|locked>
                                Apply security profile
  policy trust <path>           Add trusted directory
  policy deny <path>            Add denied directory
  policy lock|unlock            Lock policy / create UI unlock token
  secret set <NAME>             Store a secret (prompt or stdin)
  secret list                   List secret names
  secret delete <NAME>          Delete a secret
  device list                   List registered devices from the Worker
  device prefer <id>            Set sticky preferred device
  device revoke <id> [--yes]    Revoke a device on the Worker
  device clear                  Clear sticky preferred device
  plugin list                   List custom tool plugins
  plugin hash <name>            Print plugin entry sha256 for pinning

Troubleshoot:
  doctor [--json] [--strict] [--watch]
                                Check DeckAgent health and prerequisites
  smoke [--profile mcpplayground|cursor|claude-desktop] [--base-url URL] [--token TOKEN]
                                Run an MCP JSON-RPC smoke matrix against the Worker
  uninstall [--dry-run] [--keep-config] [--keep-logs] [--delete-worker] [--unregister-device] [--yes]
                                Stop daemon and safely remove local state
  version                       Print version
  help                          Print this help message

Examples:
  deckagent setup
  deckagent onboard
  deckagent ui
  deckagent doctor --strict
  deckagent smoke --profile mcpplayground
`);
}

function parseLogsOptions(args: string[]): { follow?: boolean; lines?: number } {
  const options: { follow?: boolean; lines?: number } = {};
  if (args.includes('--follow') || args.includes('-f')) {
    options.follow = true;
  }
  if (args.includes('--no-follow')) {
    options.follow = false;
  }
  const linesIndex = args.indexOf('--lines');
  if (linesIndex >= 0 && args[linesIndex + 1]) {
    const n = parseInt(args[linesIndex + 1], 10);
    if (!Number.isNaN(n) && n > 0) {
      options.lines = n;
    }
  }
  return options;
}

function parseTunnelOptions(args: string[]): { name?: string; url?: string } {
  const options: { name?: string; url?: string } = {};
  const nameIndex = args.indexOf('--name');
  if (nameIndex >= 0 && args[nameIndex + 1]) {
    options.name = args[nameIndex + 1];
  }
  const urlIndex = args.indexOf('--url');
  if (urlIndex >= 0 && args[urlIndex + 1]) {
    options.url = args[urlIndex + 1];
  }
  return options;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'setup': {
      const skipPrereqs = args.includes('--skip-prereqs');
      const skipDeploy = args.includes('--skip-deploy');
      const workerUrlIndex = args.indexOf('--worker-url');
      const workerUrl = workerUrlIndex >= 0 ? args[workerUrlIndex + 1] : undefined;
      await runSetup({ skipPrereqs, skipDeploy, workerUrl });
      break;
    }

    case 'daemon': {
      if (args.includes('--stop')) {
        stopDaemon();
        console.log('Daemon stopped.');
      } else if (args.includes('--status')) {
        if (isDaemonRunning()) {
          console.log('Daemon is running.');
        } else {
          console.log('Daemon is not running.');
          process.exit(1);
        }
      } else if (args.includes('--foreground')) {
        runDaemonForeground();
      } else {
        // Ensure service unit/task exists, then start in background.
        installDaemonService();
        startDaemon();
        console.log('Daemon started in background. Use `deckagent daemon --status` or `deckagent logs`.');
      }
      break;
    }

    case 'logs': {
      const options = parseLogsOptions(args.slice(1));
      tailLogs(options);
      break;
    }

    case 'tunnel': {
      const options = parseTunnelOptions(args.slice(1));
      await runTunnel(options);
      break;
    }

    case 'doctor': {
      const code = await runDoctor(args.slice(1));
      if (code !== 0) {
        process.exit(code);
      }
      break;
    }

    case 'workspace': {
      runWorkspaceCommand(args.slice(1));
      break;
    }

    case 'secret': {
      await runSecretCommand(args.slice(1));
      break;
    }

    case 'policy': {
      await runPolicyCommand(args.slice(1));
      break;
    }

    case 'device': {
      await runDeviceCommand(args.slice(1));
      break;
    }

    case 'token': {
      await runTokenCommand(args.slice(1));
      break;
    }

    case 'onboard': {
      const code = await runOnboardCommand(args.slice(1));
      if (code !== 0) {
        process.exit(code);
      }
      break;
    }

    case 'smoke': {
      const code = await runSmokeCommand(args.slice(1));
      if (code !== 0) {
        process.exit(code);
      }
      break;
    }

    case 'plugin': {
      await runPluginCommand(args.slice(1));
      break;
    }

    case 'ui': {
      openControlUi();
      break;
    }

    case 'uninstall': {
      await runUninstall(args.slice(1));
      break;
    }

    case 'version': {
      console.log(`deckagent v${getVersion()}`);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
