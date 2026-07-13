#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup, cleanConfig } from './setup.js';
import {
  runDaemonForeground,
  stopDaemon,
  isDaemonRunning,
  uninstallDaemonService,
  tailLogs
} from './install-daemon.js';
import { askYesNo } from './configure.js';
import { runDoctor } from './doctor.js';

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
  deckagent daemon [--foreground]  Start the desktop daemon
  deckagent daemon --stop      Stop the desktop daemon
  deckagent daemon --status    Check if the daemon is running
  deckagent logs               Tail daemon logs
  deckagent doctor             Check DeckAgent health and prerequisites
  deckagent uninstall          Stop daemon and remove config
  deckagent version            Print version
  deckagent help               Print this help message
`);
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
        runDaemonForeground();
      }
      break;
    }

    case 'logs': {
      tailLogs();
      break;
    }

    case 'doctor': {
      await runDoctor();
      break;
    }

    case 'uninstall': {
      console.log('This will stop the daemon and remove ~/.deckagent/');
      const undeploy = await askYesNo('Also undeploy the Cloudflare Worker? (requires wrangler)');
      if (undeploy) {
        try {
          const { execSync } = await import('node:child_process');
          const { resolveWorkerPackageDir } = await import('./deploy-worker.js');
          execSync('npx wrangler delete', { cwd: resolveWorkerPackageDir(), stdio: 'inherit' });
        } catch (err) {
          console.warn('Could not undeploy worker:', err instanceof Error ? err.message : String(err));
        }
      }
      uninstallDaemonService();
      cleanConfig();
      console.log('DeckAgent uninstalled.');
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
