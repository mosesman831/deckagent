import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { ensurePrerequisites } from './prerequisites.js';
import { deployWorker, type WorkerConfig } from './deploy-worker.js';
import {
  generateConfig,
  generateDefaultPolicy,
  writeConfigFiles,
  askYesNo,
  maskSecret,
  getConfigDir
} from './configure.js';
import {
  installPrerequisites,
  installDaemonService,
  startDaemon,
  isDaemonRunning,
  tailLogs
} from './install-daemon.js';

export interface SetupOptions {
  skipPrereqs?: boolean;
  skipDeploy?: boolean;
  workerUrl?: string;
}

function getAccountFromWrangler(): string | null {
  try {
    const output = execSync('npx wrangler whoami', { encoding: 'utf-8', stdio: 'pipe' });
    const match = output.match(/Account\s+([A-Za-z0-9_\-]+)/i) || output.match(/@([a-z0-9\-]+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function registerDevice(workerUrl: string, apiToken: string, deviceId: string, token: string): Promise<void> {
  const url = `${workerUrl.replace(/\/$/, '')}/api/devices`;
  const body = JSON.stringify({
    device_id: deviceId,
    name: os.hostname(),
    token,
    capabilities: ['filesystem', 'terminal', 'browser']
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device registration failed (${response.status}): ${text}`);
  }
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  console.log('=== DeckAgent Setup ===\n');

  if (!options.skipPrereqs) {
    try {
      ensurePrerequisites();
    } catch (err) {
      console.error('Prerequisite check failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  let workerUrl = options.workerUrl;

  if (!options.skipDeploy) {
    const accountTag = getAccountFromWrangler();
    const suggestedUrl = accountTag
      ? `https://deckagent.${accountTag}.workers.dev`
      : 'https://deckagent.<account>.workers.dev';

    console.log('\n--- Worker Deployment ---');
    console.log(`Your Worker will be deployed to: ${suggestedUrl}`);
    console.log('Make sure you are logged into Wrangler (run `npx wrangler login` if not).\n');

    const apiToken = crypto.randomBytes(32).toString('hex');

    const workerConfig: WorkerConfig = {
      workerName: 'deckagent',
      accountTag,
      kvNamespaceId: null,
      apiToken
    };

    try {
      const result = deployWorker(workerConfig);
      workerUrl = result.url;
      console.log(`Worker deployed: ${workerUrl}`);
    } catch (err) {
      console.error('Worker deployment failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    console.log('\n--- API Token ---');
    console.log(`Generated API token: ${maskSecret(apiToken)}`);
    console.log(`This token is stored as a Worker secret and in ${getConfigDir()}/config.json\n`);

    const deviceId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');

    try {
      await registerDevice(workerUrl, apiToken, deviceId, token);
      console.log('Device registered successfully.\n');
    } catch (err) {
      console.error('Device registration failed:', err instanceof Error ? err.message : String(err));
      const continueAnyway = await askYesNo('Continue without registering device?');
      if (!continueAnyway) {
        process.exit(1);
      }
    }

    const config = generateConfig(deviceId, token, workerUrl, apiToken);
    const policy = generateDefaultPolicy();
    writeConfigFiles(config, policy);
    console.log(`Wrote config files to ${getConfigDir()}/\n`);
  }

  if (!workerUrl) {
    console.error('No worker URL available. Run setup without --skip-deploy or provide --worker-url.');
    process.exit(1);
  }

  console.log('--- Installing Desktop Daemon ---');
  try {
    await installPrerequisites();
    installDaemonService();
    startDaemon();
    console.log('Daemon installed and started.\n');
  } catch (err) {
    console.error('Daemon installation failed:', err instanceof Error ? err.message : String(err));
    const continueAnyway = await askYesNo('Continue anyway?');
    if (!continueAnyway) {
      process.exit(1);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (isDaemonRunning()) {
    console.log('Daemon is running ✓\n');
  } else {
    console.warn('Daemon may not be running yet. Check logs with `deckagent logs`.\n');
    tailLogs({ follow: false, lines: 50 });
  }

  const mcpUrl = `${workerUrl.replace(/\/$/, '')}/mcp`;
  console.log('DeckAgent is set up!');
  console.log(`Your MCP URL: ${mcpUrl}`);
  console.log('In ChatGPT: Settings → Custom Connectors → Add → enter the URL above');
  console.log('In Claude:   Settings → Custom Connectors → Add → enter the URL above');
  console.log(`Policy file: ${getConfigDir()}/policy.json (edit to restrict access)\n`);
}

export function cleanConfig(): void {
  const configDir = getConfigDir();
  if (fs.existsSync(configDir)) {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}
