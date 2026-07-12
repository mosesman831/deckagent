import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { deployWorker, runCommand } from "./deploy.js";
import { saveConfig, savePolicy, getConfigDir, type DeckAgentConfig } from "./config.js";
import { generateDeviceId, generateToken, registerDevice } from "./device.js";
import { installDaemon, daemonCommand } from "./daemon.js";

export interface SetupOptions {
  workerName: string;
  deviceName: string;
  githubClientId?: string;
  githubClientSecret?: string;
  accountId?: string;
  yes?: boolean;
}

export async function setup(options: SetupOptions): Promise<void> {
  checkNode();
  await ensureCommand("npm");
  await ensureCommand("npx");
  const githubClientId = options.githubClientId ?? await ask(options.yes, "GitHub OAuth client ID: ");
  const githubClientSecret = options.githubClientSecret ?? await ask(options.yes, "GitHub OAuth client secret: ");
  if (!githubClientId || !githubClientSecret) throw new Error("GitHub OAuth credentials are required. Create an OAuth App with callback URL {worker_url}/auth/callback.");
  let accountId = options.accountId;
  if (!accountId) {
    try { accountId = (await runCommand("npx", ["wrangler", "whoami"])).match(/[a-f0-9]{32}/i)?.[0]; } catch { /* deploy will show login guidance */ }
  }
  if (!accountId) console.log("Cloudflare account ID was not detected; Wrangler will use the logged-in account.");
  const workerConfigPath = "packages/cloudflare-worker/wrangler.jsonc";
  const workerConfig = { name: options.workerName, main: "src/index.ts", compatibility_date: "2026-06-01", compatibility_flags: ["nodejs_compat"], kv_namespaces: [{ binding: "DECK_KV", id: "" }], vars: { GITHUB_CLIENT_ID: githubClientId, APP_NAME: "DeckAgent" }, ...(accountId ? { account_id: accountId } : {}) };
  await writeFile(workerConfigPath, JSON.stringify(workerConfig, null, 2));
  const namespaceOutput = await runCommand("npx", ["wrangler", "kv", "namespace", "create", "DECK_KV", "--json"]);
  const namespaceId = namespaceOutput.match(/"id"\s*:\s*"([a-f0-9]+)"/i)?.[1];
  if (!namespaceId) throw new Error("Wrangler did not return a KV namespace ID");
  workerConfig.kv_namespaces[0].id = namespaceId;
  await writeFile(workerConfigPath, JSON.stringify(workerConfig, null, 2));
  console.log("If Wrangler asks for authentication, run `npx wrangler login` and rerun setup.");
  const workerUrl = await deployWorker();
  const deploySecret = randomBytes(32).toString("hex");
  await putSecret("GITHUB_CLIENT_SECRET", githubClientSecret);
  await runCommand("npx", ["wrangler", "kv", "key", "put", "deploy:secret", deploySecret, "--binding", "DECK_KV"]);
  const config: DeckAgentConfig = { device_id: generateDeviceId(), token: generateToken(), worker_url: workerUrl, device_name: options.deviceName || hostname(), heartbeat_interval: 15, tool_timeout: 60, auto_connect: true, log_level: "info" };
  await mkdir(getConfigDir(), { recursive: true });
  await saveConfig(config);
  await savePolicy({ allowed_directories: [process.cwd()], blocked_commands: ["rm -rf /", "mkfs", "shutdown"], require_confirmation: false, read_only: false });
  await registerDevice({ deploySecret, deviceName: config.device_name });
  await runCommand("npm", ["run", "build", "-w", "@deckagent/mcp-server", "-w", "@deckagent/desktop-daemon"]);
  await installDaemon();
  await daemonCommand("start");
  console.log(`Worker URL: ${workerUrl}\nDevice ID: ${config.device_id}\nDevice token: ${config.token}\nConfig: ${join(getConfigDir(), "config.json")}\nLogs: ${join(getConfigDir(), "logs")}/`);
}

function checkNode(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 20) throw new Error(`Node.js 20 or newer is required (found ${process.versions.node})`);
}

async function ensureCommand(command: string): Promise<void> {
  try { await runCommand(command, ["--version"]); } catch { throw new Error(`${command} is required but was not found`); }
}

async function putSecret(name: string, value: string): Promise<void> {
  const child = spawn("npx", ["wrangler", "secret", "put", name], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(`${value}\n`);
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.on("error", () => reject(new Error(`Unable to set Wrangler secret ${name}`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Wrangler failed to set secret ${name}`)));
  });
}

async function ask(skip: boolean | undefined, question: string): Promise<string> {
  if (skip) return "";
  const rl = createInterface({ input, output });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
