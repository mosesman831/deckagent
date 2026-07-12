import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config.js";
import { runCommand } from "./deploy.js";

const home = homedir();
const daemonDir = join(home, ".deckagent");
const pidPath = join(daemonDir, "daemon.pid");
const logPath = join(daemonDir, "logs", "deckagent.log");
const launchAgentPath = join(home, "Library", "LaunchAgents", "com.deckagent.daemon.plist");
const systemdPath = join(home, ".config", "systemd", "user", "deckagent.service");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");

export async function daemonCommand(action: "start" | "stop" | "status" | "restart", foreground = false): Promise<void> {
  if (foreground) return runForeground();
  if (action === "restart") { await daemonCommand("stop"); await daemonCommand("start"); return; }
  if (action === "start") return startDaemon();
  if (action === "stop") return stopDaemon();
  return statusDaemon();
}

export async function runForeground(): Promise<void> {
  const config = await loadConfig();
  if (!config) throw new Error("Run deckagent setup first");
  const daemonEntry = join(repoRoot, "packages/desktop-daemon/dist/index.js");
  if (!existsSync(daemonEntry)) await runCommand("npm", ["run", "build", "-w", "@deckagent/desktop-daemon"], repoRoot);
  const child = spawn(process.execPath, [daemonEntry], { stdio: "inherit", env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.on("error", () => reject(new Error("Unable to start the desktop daemon")));
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Desktop daemon exited with code ${code ?? "unknown"}`)));
  });
}

export async function installDaemon(): Promise<void> {
  await mkdir(join(daemonDir, "logs"), { recursive: true });
  await mkdir(join(daemonDir, "bin"), { recursive: true });
  const wrapper = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repoRoot, "packages/desktop-daemon/dist/index.js"))} "$@"\n`;
  await writeFile(join(daemonDir, "bin/deckagent-daemon"), wrapper, { mode: 0o755 });
  if (platform() === "darwin") {
    await mkdir(dirname(launchAgentPath), { recursive: true });
    await writeFile(launchAgentPath, launchAgentPlist(), "utf8");
    await runCommand("launchctl", ["load", "-w", launchAgentPath]);
  } else if (platform() === "linux") {
    await mkdir(dirname(systemdPath), { recursive: true });
    await writeFile(systemdPath, systemdUnit(), "utf8");
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", "--now", "deckagent.service"]);
  } else {
    console.log(`Service manager unsupported; use ${join(daemonDir, "bin/deckagent-daemon")}`);
  }
}

async function startDaemon(): Promise<void> {
  const config = await loadConfig();
  if (!config) throw new Error("Run deckagent setup first");
  if (platform() === "darwin" && existsSync(launchAgentPath)) return runCommand("launchctl", ["start", "com.deckagent.daemon"]).then(() => undefined);
  if (platform() === "linux" && existsSync(systemdPath)) return runCommand("systemctl", ["--user", "start", "deckagent.service"]).then(() => undefined);
  await mkdir(join(daemonDir, "logs"), { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon", "--foreground"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  if (!child.pid) throw new Error("Unable to start the daemon");
  await writeFile(pidPath, `${child.pid}\n`, "utf8");
  child.unref();
}

async function stopDaemon(): Promise<void> {
  if (platform() === "darwin" && existsSync(launchAgentPath)) { await runCommand("launchctl", ["stop", "com.deckagent.daemon"]); return; }
  if (platform() === "linux" && existsSync(systemdPath)) { await runCommand("systemctl", ["--user", "stop", "deckagent.service"]); return; }
  try {
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    if (Number.isInteger(pid)) process.kill(pid, "SIGTERM");
  } catch { /* Missing or already stopped. */ }
  await rm(pidPath, { force: true });
}

async function statusDaemon(): Promise<void> {
  const config = await loadConfig();
  if (!config) throw new Error("Run deckagent setup first");
  let running = false;
  try {
    if (platform() === "darwin" && existsSync(launchAgentPath)) { await runCommand("launchctl", ["list", "com.deckagent.daemon"]); running = true; }
    else if (platform() === "linux" && existsSync(systemdPath)) { await runCommand("systemctl", ["--user", "is-active", "--quiet", "deckagent.service"]); running = true; }
    else { const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10); process.kill(pid, 0); running = true; }
  } catch { running = false; }
  let workerOnline = false;
  try { workerOnline = (await fetch(config.worker_url)).ok; } catch { workerOnline = false; }
  console.log(`Daemon: ${running ? "running" : "stopped"}\nWorker: ${workerOnline ? "online" : "offline"}`);
}

export async function tailLogs(): Promise<void> {
  const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

export async function uninstallDaemon(removeConfig: boolean): Promise<void> {
  await stopDaemon();
  if (platform() === "darwin" && existsSync(launchAgentPath)) { await runCommand("launchctl", ["unload", "-w", launchAgentPath]); await rm(launchAgentPath, { force: true }); }
  if (platform() === "linux" && existsSync(systemdPath)) { await runCommand("systemctl", ["--user", "disable", "--now", "deckagent.service"]); await rm(systemdPath, { force: true }); }
  const shouldRemove = removeConfig || await confirmRemoval();
  if (shouldRemove) await rm(daemonDir, { recursive: true, force: true });
}

async function confirmRemoval(): Promise<boolean> {
  const rl = createInterface({ input, output });
  try { return (await rl.question("Remove ~/.deckagent configuration and logs? [y/N] ")).trim().toLowerCase() === "y"; } finally { rl.close(); }
}

function launchAgentPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.deckagent.daemon</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${join(repoRoot, "packages/desktop-daemon/dist/index.js")}</string></array><key>WorkingDirectory</key><string>${repoRoot}</string><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${logPath}</string><key>StandardErrorPath</key><string>${logPath}</string></dict></plist>\n`;
}

function systemdUnit(): string {
  return `[Unit]\nDescription=DeckAgent desktop daemon\nAfter=network-online.target\n\n[Service]\nExecStart=${process.execPath} ${join(repoRoot, "packages/desktop-daemon/dist/index.js")}\nWorkingDirectory=${repoRoot}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}
