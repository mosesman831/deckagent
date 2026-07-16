import { spawn } from "node:child_process";

export type DesktopNotifier = (title: string, body: string) => void;

/**
 * Best-effort desktop notification. Never throws; never fails the caller.
 */
export function sendDesktopNotification(
  title: string,
  body: string,
): void {
  try {
    const platform = process.platform;
    if (platform === "linux") {
      notifyLinux(title, body);
    } else if (platform === "darwin") {
      notifyMac(title, body);
    } else if (platform === "win32") {
      notifyWindows(title, body);
    }
  } catch {
    // Ignore — notifications are optional.
  }
}

function notifyLinux(title: string, body: string): void {
  const child = spawn("notify-send", [title, body], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // notify-send missing — ignore
  });
  child.unref();
}

function notifyMac(title: string, body: string): void {
  // Escape for AppleScript string literals.
  const safeTitle = escapeAppleScript(title);
  const safeBody = escapeAppleScript(body);
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  const child = spawn("osascript", ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // ignore
  });
  child.unref();
}

function notifyWindows(title: string, body: string): void {
  // Balloon tip via PowerShell — skip gracefully if PowerShell unavailable.
  const safeTitle = escapePowerShell(title);
  const safeBody = escapePowerShell(body);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms;
$n = New-Object System.Windows.Forms.NotifyIcon;
$n.Icon = [System.Drawing.SystemIcons]::Information;
$n.BalloonTipTitle = '${safeTitle}';
$n.BalloonTipText = '${safeBody}';
$n.Visible = $true;
$n.ShowBalloonTip(8000);
Start-Sleep -Seconds 9;
$n.Dispose();
`.replace(/\n/g, " ");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.on("error", () => {
    // ignore
  });
  child.unref();
}

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapePowerShell(text: string): string {
  return text.replace(/'/g, "''");
}
