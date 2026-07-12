import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname } from "node:path";
import {
  type Config,
  defaultPolicy,
  ensureConfigDir,
  generateDeploySecret,
  generateDeviceId,
  generateToken,
  getConfigPath,
  getLogsDir,
  getWorkerDir,
  getWranglerConfigPath,
  loadPartialConfig,
  prompt,
  saveConfig,
  savePolicy,
} from "./config.js";
import { parseWorkerUrl, wrangler, wranglerCapture } from "./deploy.js";
import { postDevice } from "./device.js";
import {
  buildDaemon,
  commandExists,
  installService,
  startDaemon,
} from "./daemon.js";

const CAPABILITIES = ["filesystem", "terminal", "browser"];

export interface SetupOptions {
  workerName?: string;
  deviceName?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  accountId?: string;
  yes?: boolean;
}

export async function runSetup(
  options: SetupOptions = {},
  home: string = homedir(),
): Promise<void> {
  console.log("=== DeckAgent setup ===\n");

  // 1. Node version.
  checkNodeVersion(20);

  // 2. Prerequisites.
  checkPrerequisites();

  // 3. Config dir + existing values.
  ensureConfigDir(home);
  const existing = loadPartialConfig(home);

  // 4. Gather inputs.
  const workerName = options.workerName ?? "deckagent";
  const deviceName =
    options.deviceName ?? existing.device_name ?? hostname();

  ensureCloudflareLogin(options.yes ?? false);
  const accountId = options.accountId ?? resolveAccountId();
  if (accountId) {
    // wrangler reads the account from this env var when set.
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    console.log(`Using Cloudflare account ${accountId}.`);
  }

  let githubClientId = options.githubClientId ?? "";
  if (!githubClientId && !options.yes) {
    printGithubOAuthGuide(workerName);
    githubClientId = await prompt("GitHub OAuth Client ID");
  }
  let githubClientSecret = options.githubClientSecret ?? "";
  if (githubClientId && !githubClientSecret && !options.yes) {
    githubClientSecret = await prompt("GitHub OAuth Client Secret");
  }

  // 5. KV namespace + wrangler.jsonc.
  //    Write a base config first so wrangler can resolve the worker name, then
  //    patch in the namespace id once it is created.
  writeWranglerConfig(workerName, "", githubClientId);
  const kvId = createKvNamespace();
  writeWranglerConfig(workerName, kvId, githubClientId);

  if (githubClientSecret) {
    putSecret("GITHUB_CLIENT_SECRET", githubClientSecret);
  } else {
    console.log(
      "No GitHub client secret provided. Set it later with `npx wrangler secret put GITHUB_CLIENT_SECRET`.",
    );
  }
  // Cookie encryption key for OAuth session cookies (SPEC §2.2).
  putSecret("COOKIE_ENCRYPTION_KEY", randomBytes(32).toString("hex"));

  // 6. Deploy worker.
  const workerUrl = deployWorker();

  // 7-8. Deploy secret -> KV.
  const deploySecret = generateDeploySecret();
  putKvValue("deploy:secret", deploySecret);

  // 9. Device identity.
  const deviceId = existing.device_id ?? generateDeviceId();
  const token = existing.token ?? generateToken();

  // 10. Register device.
  await postDevice(workerUrl, deploySecret, {
    device_id: deviceId,
    name: deviceName,
    token,
    capabilities: CAPABILITIES,
  });
  console.log(`Registered device ${deviceName} (${deviceId}).`);

  // 11. config.json.
  const config: Config = {
    device_id: deviceId,
    token,
    worker_url: workerUrl,
    device_name: deviceName,
    heartbeat_interval: existing.heartbeat_interval ?? 15,
    tool_timeout: existing.tool_timeout ?? 60,
    auto_connect: existing.auto_connect ?? true,
    log_level: existing.log_level ?? "info",
  };
  saveConfig(config, home);

  // 12. policy.json.
  savePolicy(defaultPolicy(home), home);

  // 13. Build + install daemon as a user service.
  buildDaemon();
  installService(home);

  // 14. Start daemon.
  try {
    startDaemon(home);
  } catch (err) {
    console.error(`Daemon did not start automatically: ${(err as Error).message}`);
    console.error("Start it manually with `deckagent daemon start`.");
  }

  // 15. Summary.
  printSummary(config, home);
}

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

function checkNodeVersion(minMajor: number): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < minMajor) {
    console.error(
      `Node.js >= ${minMajor} is required (found ${process.versions.node}). Upgrade Node and re-run.`,
    );
    process.exit(1);
  }
}

function checkPrerequisites(): void {
  if (!commandExists("npm")) {
    console.error("npm is required but was not found on PATH.");
    process.exit(1);
  }
  if (!commandExists("git")) {
    console.log("Warning: git was not found on PATH; some features may not work.");
  }
  // wrangler is invoked through `npx`, so a global install is not required.
  console.log("Prerequisites OK (wrangler will run via npx).");
}

function ensureCloudflareLogin(nonInteractive: boolean): void {
  const who = wranglerCapture(["whoami"]);
  if (who.code === 0 && !/not (authenticated|logged)/i.test(who.stdout + who.stderr)) {
    return;
  }
  if (nonInteractive) {
    console.error(
      "Not logged into Cloudflare. Run `npx wrangler login` first (cannot prompt in --yes mode).",
    );
    process.exit(1);
  }
  console.log("Logging into Cloudflare via wrangler...");
  wrangler(["login"]);
}

function resolveAccountId(): string {
  const who = wranglerCapture(["whoami"]);
  const match = who.stdout.match(/([0-9a-f]{32})/);
  return match ? match[1] : "";
}

// ---------------------------------------------------------------------------
// Cloudflare resources
// ---------------------------------------------------------------------------

function createKvNamespace(): string {
  console.log('Creating KV namespace "DECK_KV"...');
  const result = wranglerCapture(["kv", "namespace", "create", "DECK_KV"], getWorkerDir());
  const combined = `${result.stdout}\n${result.stderr}`;
  const id = parseKvId(combined);
  if (!id) {
    console.log(combined);
    throw new Error(
      "Could not determine the KV namespace id from wrangler output. Create it manually and re-run.",
    );
  }
  console.log(`KV namespace ready (id ${id}).`);
  return id;
}

export function parseKvId(output: string): string | null {
  const patterns = [
    /"id"\s*:\s*"([0-9a-fA-F]{32})"/,
    /\bid\s*=\s*"([0-9a-fA-F]{32})"/,
    /\bid:\s*([0-9a-fA-F]{32})/,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return m[1];
  }
  return null;
}

function writeWranglerConfig(
  workerName: string,
  kvId: string,
  githubClientId: string,
): void {
  const path = getWranglerConfigPath();
  const config = {
    name: workerName,
    main: "src/index.ts",
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    kv_namespaces: [{ binding: "DECK_KV", id: kvId }],
    vars: {
      GITHUB_CLIENT_ID: githubClientId,
      APP_NAME: "DeckAgent",
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  const banner =
    "// Generated by `deckagent setup`. Secrets are set via `wrangler secret put`.\n";
  writeFileSync(path, banner + JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path}`);
}

function putSecret(name: string, value: string): void {
  console.log(`Setting Worker secret ${name}...`);
  const result = spawnSync("npx", ["--yes", "wrangler", "secret", "put", name], {
    cwd: getWorkerDir(),
    input: `${value}\n`,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to set secret ${name} (exit ${result.status}).`);
  }
}

function putKvValue(key: string, value: string): void {
  const result = wranglerCapture(
    ["kv", "key", "put", key, value, "--binding", "DECK_KV", "--remote"],
    getWorkerDir(),
  );
  if (result.code !== 0) {
    console.log(result.stdout);
    console.error(result.stderr);
    throw new Error(`Failed to store KV key ${key} (exit ${result.code}).`);
  }
  console.log(`Stored KV key ${key}.`);
}

function deployWorker(): string {
  console.log("Deploying Worker with wrangler...");
  const result = wranglerCapture(["deploy"], getWorkerDir());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) {
    throw new Error(`wrangler deploy failed (exit ${result.code}).`);
  }
  const url = parseWorkerUrl(`${result.stdout}\n${result.stderr}`);
  if (!url) {
    throw new Error("Deployed, but could not determine the worker URL from output.");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Guidance + summary
// ---------------------------------------------------------------------------

function printGithubOAuthGuide(workerName: string): void {
  console.log(`
GitHub OAuth App required. Create one at:
  https://github.com/settings/developers  ->  "New OAuth App"

  Application name:  DeckAgent
  Homepage URL:      https://github.com
  Callback URL:      https://${workerName}.<your-subdomain>.workers.dev/auth/callback

After creating it, copy the Client ID and generate a Client Secret.
`);
}

function printSummary(config: Config, home: string): void {
  console.log(`
=== DeckAgent is set up ===

Worker URL:    ${config.worker_url}
MCP endpoint:  ${config.worker_url}/mcp
Device ID:     ${config.device_id}
Device token:  ${config.token}
Config:        ${getConfigPath(home)}
Logs:          ${getLogsDir(home)}

Connect your AI:
  ChatGPT:  Settings -> Connectors -> Add -> paste ${config.worker_url}/mcp
  Claude:   Settings -> Connectors -> Add -> paste ${config.worker_url}/mcp
`);
}
