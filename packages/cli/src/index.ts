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
  deckagent setup              Run the full setup wizard
  deckagent daemon [--foreground]  Start the desktop daemon (background by default)
  deckagent daemon --stop      Stop the desktop daemon
  deckagent daemon --status    Check if the daemon is running
  deckagent logs [--follow] [--lines N]  Tail daemon logs (follows on TTY by default)
  deckagent tunnel [--name NAME] [--url URL]  Cloudflare Tunnel to local wrangler (dev)
  deckagent device list        List registered devices from the Worker
  deckagent device prefer <id> Set sticky preferred device
  deckagent device clear       Clear sticky preferred device
  deckagent workspace use <path>  Set active workspace (project scope)
  deckagent workspace status   Show current workspace
  deckagent workspace clear    Clear workspace from config
  deckagent secret set <NAME>  Store a secret (prompt or stdin)
  deckagent secret list        List secret names
  deckagent secret delete <NAME>  Delete a secret
  deckagent policy show        Show effective policy
  deckagent policy set-profile <strict|dev|locked>  Apply security profile
  deckagent policy trust <path>   Add trusted directory
  deckagent policy deny <path>    Add denied directory
  deckagent policy lock|unlock    Lock policy / create UI unlock token
  deckagent plugin list        List custom tool plugins
  deckagent ui                 Open local control UI (http://127.0.0.1:9150)
  deckagent doctor [--watch]   Check DeckAgent health and prerequisites
  deckagent uninstall [--dry-run] [--keep-config] [--keep-logs] [--delete-worker] [--unregister-device] [--yes]
                               Stop daemon and safely remove local state
  deckagent version            Print version
  deckagent help               Print this help message
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
