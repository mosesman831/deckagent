import { spawn, execSync } from 'node:child_process';
import os from 'node:os';
import { configExists, readConfig, maskSecret } from './configure.js';

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8787';

export interface TunnelOptions {
  /** Named Cloudflare tunnel name (requires prior cloudflared tunnel create). */
  name?: string;
  /** Local origin to expose (wrangler dev default). */
  url?: string;
}

function commandExists(cmd: string): boolean {
  try {
    const check = os.platform() === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(check, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function isCloudflaredInstalled(): boolean {
  return commandExists('cloudflared');
}

function printInstallHint(): void {
  console.error(`cloudflared is not installed or not on PATH.

Install Cloudflare Tunnel (cloudflared):
  macOS:  brew install cloudflare/cloudflare/cloudflared
  Linux:  see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
  Windows: winget install --id Cloudflare.cloudflared

Then re-run: deckagent tunnel`);
}

function printMcpReminder(publicBaseUrl: string | null): void {
  console.log('\n--- MCP connector ---');
  if (publicBaseUrl) {
    const mcpUrl = `${publicBaseUrl.replace(/\/$/, '')}/mcp`;
    console.log(`MCP URL (once the tunnel is up): ${mcpUrl}`);
  } else {
    console.log('MCP URL: https://<tunnel-hostname>/mcp');
  }

  if (configExists()) {
    try {
      const config = readConfig();
      console.log(`API token (from ~/.deckagent/config.json): ${maskSecret(config.api_token)}`);
      console.log('Use this Bearer token when adding the custom connector in ChatGPT/Claude.');
    } catch {
      console.log('Could not read api_token from config. Check ~/.deckagent/config.json.');
    }
  } else {
    console.log('No ~/.deckagent/config.json yet — run `deckagent setup` first, or set the Worker API_TOKEN secret.');
  }
}

function printNamedTunnelDocs(name: string): void {
  console.log(`
Named tunnel "${name}" — one-time setup (if not already done):

  1. cloudflared tunnel login
  2. cloudflared tunnel create ${name}
  3. cloudflared tunnel route dns ${name} deckagent.example.com
  4. Create ~/.cloudflared/config.yml with:

       tunnel: ${name}
       credentials-file: /path/to/${name}.json
       ingress:
         - hostname: deckagent.example.com
           service: ${DEFAULT_LOCAL_URL}
         - service: http_status:404

  Or run: cloudflared tunnel run ${name}

See README § "Named Cloudflare tunnels" for production Worker hosting (workers.dev)
vs local wrangler + tunnel for development.
`);
}

/**
 * Start a Cloudflare Tunnel against local wrangler (or a configured URL).
 * Default: quick tunnel (`cloudflared tunnel --url ...`).
 * With --name: runs a named tunnel (`cloudflared tunnel run NAME`).
 */
export async function runTunnel(options: TunnelOptions = {}): Promise<void> {
  if (!isCloudflaredInstalled()) {
    printInstallHint();
    process.exit(1);
  }

  const localUrl = options.url ?? DEFAULT_LOCAL_URL;

  if (options.name) {
    printNamedTunnelDocs(options.name);
    printMcpReminder(null);
    console.log(`Starting named tunnel: cloudflared tunnel run ${options.name}\n`);
    const child = spawn('cloudflared', ['tunnel', 'run', options.name], {
      stdio: 'inherit',
      detached: false
    });
    child.on('error', (err) => {
      console.error('Failed to start cloudflared:', err.message);
      process.exit(1);
    });
    child.on('exit', (code) => {
      process.exit(code ?? 1);
    });
    return;
  }

  console.log('=== DeckAgent Quick Tunnel ===\n');
  console.log(`Exposing ${localUrl} via cloudflared quick tunnel (dev).`);
  console.log('Start `npx wrangler dev --port 8787` in another terminal if it is not already running.\n');
  printMcpReminder(null);
  console.log('cloudflared will print a https://*.trycloudflare.com URL — use that as your Worker base.\n');
  console.log('Starting: cloudflared tunnel --url ' + localUrl + '\n');

  const child = spawn('cloudflared', ['tunnel', '--url', localUrl], {
    stdio: 'inherit',
    detached: false
  });

  child.on('error', (err) => {
    console.error('Failed to start cloudflared:', err.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}
