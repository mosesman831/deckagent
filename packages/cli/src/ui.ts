import { spawn } from 'node:child_process';
import process from 'node:process';

/** Local control UI (daemon loopback). See WAVE3 F5. */
export const CONTROL_UI_URL = 'http://127.0.0.1:9150';

/**
 * Print the control UI URL and best-effort open it in the default browser.
 * Never fails the CLI if the opener is missing — URL is always printed.
 */
export function openControlUi(url: string = CONTROL_UI_URL): void {
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
