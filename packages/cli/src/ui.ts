import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Local control UI (daemon loopback). See WAVE3 F5. */
export const CONTROL_UI_URL = 'http://127.0.0.1:9150';
export const CONTROL_UI_TOKEN_FILE = 'ui.token';

export function getControlUiTokenPath(baseDir = path.join(os.homedir(), '.deckagent')): string {
  return path.join(baseDir, CONTROL_UI_TOKEN_FILE);
}

export function readControlUiToken(baseDir?: string): string {
  const tokenPath = getControlUiTokenPath(baseDir);
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (/^[0-9a-fA-F]{64,}$/.test(token)) {
      return token;
    }
    throw new Error(`Control UI token at ${tokenPath} is invalid`);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Control UI token not found at ${tokenPath}. Start the daemon, then run \`deckagent ui\` again.`);
    }
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`Could not read Control UI token at ${tokenPath}`);
  }
}

export function buildControlUiUrl(options?: {
  baseUrl?: string;
  baseDir?: string;
}): string {
  const baseUrl = options?.baseUrl ?? CONTROL_UI_URL;
  const token = readControlUiToken(options?.baseDir);
  const url = new URL(baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Print the control UI URL and best-effort open it in the default browser.
 * Requires the daemon-generated local token, but never fails if the opener is missing.
 */
export function openControlUi(url: string = buildControlUiUrl()): void {
  console.log(url);

  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => {
      // Opener unavailable — URL already printed.
    });
    child.unref();
  } catch {
    // Best-effort only.
  }
}
