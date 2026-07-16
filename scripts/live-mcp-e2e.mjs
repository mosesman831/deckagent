#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const WORKER_DIR = path.join(ROOT, "packages", "cloudflare-worker");
const DAEMON_ENTRY = path.join(ROOT, "packages", "desktop-daemon", "dist", "src", "index.js");
const MCP_ENTRY = path.join(ROOT, "packages", "mcp-server", "dist", "src", "index.js");
const CLI_ENTRY = path.join(ROOT, "packages", "cli", "dist", "index.js");
const DEV_VARS_PATH = path.join(WORKER_DIR, ".dev.vars");
const WRANGLER_CONFIG_PATH = path.join(WORKER_DIR, "wrangler.jsonc");
const BASE_URL = process.env.DECKAGENT_E2E_BASE_URL ?? "http://127.0.0.1:8787";
const PORT = new URL(BASE_URL).port || "8787";
const SKIP = process.env.DECKAGENT_E2E_SKIP === "1";
const KEEP_TEMP = process.env.DECKAGENT_E2E_KEEP_TEMP === "1";
const FORCE_BUILD = process.env.DECKAGENT_E2E_FORCE_BUILD === "1";
const WORKER_READY_TIMEOUT_MS = Number(process.env.DECKAGENT_E2E_WORKER_TIMEOUT_MS ?? 90_000);
const DAEMON_READY_TIMEOUT_MS = Number(process.env.DECKAGENT_E2E_DAEMON_TIMEOUT_MS ?? 90_000);
const MCP_TIMEOUT_MS = Number(process.env.DECKAGENT_E2E_MCP_TIMEOUT_MS ?? 30_000);
const LOCAL_RATE_LIMIT_RPM = "600";

const children = [];
let tempRoot = "";
let deviceId = "";
let apiToken = "";
let devVarsRestore = null;
let wranglerConfigRestore = null;
let cleaned = false;

function log(message = "") {
  console.log(`[live-mcp-e2e] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

class FatalWaitError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalWaitError";
  }
}

function fatalWait(message) {
  throw new FatalWaitError(message);
}

function randomToken() {
  return randomBytes(32).toString("hex");
}

function truncate(value, max = 500) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function createOutputBuffer(name) {
  const lines = [];
  return {
    name,
    push(chunk) {
      const text = chunk.toString("utf-8");
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        lines.push(line);
        if (lines.length > 120) lines.shift();
        console.log(`[${name}] ${line}`);
      }
    },
    tail() {
      return lines.slice(-30).join("\n");
    },
  };
}

async function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createOutputBuffer(command);
  const stderr = createOutputBuffer(`${command}:err`);
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    fail(
      `Command failed (${code}): ${command} ${args.join(" ")}\n` +
        `${stdout.tail()}\n${stderr.tail()}`.trim(),
    );
  }
}

function spawnManaged(name, command, args, options = {}) {
  const output = createOutputBuffer(name);
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (chunk) => output.push(chunk));
  child.stderr?.on("data", (chunk) => output.push(chunk));
  child.on("exit", (code, signal) => {
    output.push(Buffer.from(`process exited code=${code} signal=${signal}\n`));
  });
  children.push({ name, child, output });
  return { child, output };
}

async function stopManaged(entry) {
  if (!entry?.child?.pid || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const pid = entry.child.pid;
  const signalTarget = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(signalTarget, "SIGTERM");
  } catch {
    return;
  }

  const exited = await Promise.race([
    new Promise((resolve) => entry.child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) {
    try {
      process.kill(signalTarget, "SIGKILL");
    } catch {
      // Process may have exited after the timeout.
    }
  }
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;

  if (apiToken && deviceId) {
    await fetch(`${BASE_URL}/api/devices/${deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    }).catch(() => undefined);
    await fetch(`${BASE_URL}/api/devices/prefer`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    }).catch(() => undefined);
  }

  for (const entry of [...children].reverse()) {
    await stopManaged(entry);
  }

  if (devVarsRestore) {
    if (devVarsRestore.existed) {
      writeFileSync(DEV_VARS_PATH, devVarsRestore.content, { mode: 0o600 });
    } else {
      rmSync(DEV_VARS_PATH, { force: true });
    }
  }

  if (wranglerConfigRestore) {
    writeFileSync(WRANGLER_CONFIG_PATH, wranglerConfigRestore, { mode: 0o644 });
  }

  if (tempRoot && !KEEP_TEMP) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else if (tempRoot) {
    log(`kept temp root: ${tempRoot}`);
  }
}

process.on("SIGINT", () => {
  cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  cleanup().finally(() => process.exit(143));
});

async function checkWrangler() {
  try {
    await run("npx", ["--no-install", "wrangler", "--version"], { cwd: WORKER_DIR });
  } catch (err) {
    if (SKIP) {
      log("wrangler is not installed; DECKAGENT_E2E_SKIP=1, skipping live MCP E2E.");
      process.exit(0);
    }
    fail(
      "wrangler is required for live MCP E2E. Install dependencies with `npm install` " +
        "or add wrangler with `npm install --workspace=packages/cloudflare-worker --save-dev wrangler`.",
    );
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildIfNeeded() {
  const missing = [];
  for (const filePath of [MCP_ENTRY, DAEMON_ENTRY, CLI_ENTRY]) {
    if (!(await pathExists(filePath))) missing.push(path.relative(ROOT, filePath));
  }
  if (!FORCE_BUILD && missing.length === 0) {
    log("build outputs already present; skipping build (set DECKAGENT_E2E_FORCE_BUILD=1 to force).");
    return;
  }
  if (missing.length > 0) {
    log(`missing build outputs: ${missing.join(", ")}`);
  }
  await run("npm", ["run", "build"], { cwd: ROOT });
}

function readDevVarsToken() {
  if (!existsSync(DEV_VARS_PATH)) return null;
  const raw = readFileSync(DEV_VARS_PATH, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*API_TOKEN\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[1].trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  return null;
}

function ensureDevVarsApiToken() {
  const existingContent = existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, "utf-8") : "";
  const token = readDevVarsToken() ?? randomToken();
  const linesToAppend = [];
  if (!readDevVarsToken()) {
    linesToAppend.push(`API_TOKEN=${token}`);
  }
  if (!/^\s*RATE_LIMIT_DEVICE_RPM\s*=/m.test(existingContent)) {
    linesToAppend.push(`RATE_LIMIT_DEVICE_RPM=${LOCAL_RATE_LIMIT_RPM}`);
  }
  if (!/^\s*RATE_LIMIT_MCP_RPM\s*=/m.test(existingContent)) {
    linesToAppend.push(`RATE_LIMIT_MCP_RPM=${LOCAL_RATE_LIMIT_RPM}`);
  }

  if (linesToAppend.length === 0) {
    log("using API_TOKEN from packages/cloudflare-worker/.dev.vars");
    return token;
  }

  devVarsRestore = { existed: existsSync(DEV_VARS_PATH), content: existingContent };
  const separator = existingContent.endsWith("\n") || !existingContent ? "" : "\n";
  const next = `${existingContent}${separator}${linesToAppend.join("\n")}\n`;
  writeFileSync(DEV_VARS_PATH, next, { mode: 0o600 });
  log(`wrote temporary local vars to packages/cloudflare-worker/.dev.vars (${linesToAppend.map((line) => line.split("=")[0]).join(", ")})`);
  return token;
}

function ensureLocalWranglerConfig() {
  const content = readFileSync(WRANGLER_CONFIG_PATH, "utf-8");
  if (!/"id"\s*:\s*""/.test(content)) return;

  wranglerConfigRestore = content;
  const next = content.replaceAll(
    /"id"\s*:\s*""/g,
    '"id": "00000000000000000000000000000001"',
  );
  writeFileSync(WRANGLER_CONFIG_PATH, next);
  log("wrote temporary local KV id to packages/cloudflare-worker/wrangler.jsonc");
}

async function waitFor(name, timeoutMs, probe) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      if (err instanceof FatalWaitError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`Timed out waiting for ${name}${lastError ? ` (${lastError})` : ""}`);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MCP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      fail(`Expected JSON from ${url}, got status=${res.status} body=${truncate(text)}`);
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function workerApi(pathname, options = {}) {
  return fetchJson(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

let rpcId = 1;
async function mcp(method, params = {}) {
  const body = { jsonrpc: "2.0", id: rpcId++, method, params };
  const { status, json } = await fetchJson(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-DeckAgent-Device-Id": deviceId,
    },
    body: JSON.stringify(body),
  });
  if (status !== 200 || json.error) {
    fail(`${method} failed: status=${status} body=${truncate(json)}`);
  }
  return json.result;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function toolText(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function parseToolJson(result, label) {
  const text = toolText(result);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned non-JSON tool text: ${truncate(text)}`);
  }
}

function pass(step, detail = "") {
  console.log(`PASS ${step}${detail ? ` - ${detail}` : ""}`);
}

async function writeLocalConfig() {
  tempRoot = await mkdtemp(path.join(tmpdir(), "deckagent-live-mcp-"));
  const home = path.join(tempRoot, "home");
  const deckDir = path.join(home, ".deckagent");
  const workspaceDir = path.join(tempRoot, "workspace");
  mkdirSync(deckDir, { recursive: true });
  mkdirSync(path.join(deckDir, "logs"), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(path.join(workspaceDir, "README.txt"), "deckagent live mcp e2e\n", { mode: 0o600 });

  deviceId = randomUUID();
  const deviceToken = randomToken();
  const configPath = path.join(deckDir, "config.json");
  const config = {
    device_id: deviceId,
    token: deviceToken,
    worker_url: BASE_URL,
    device_name: "deckagent-live-mcp-e2e",
    heartbeat_interval: 5,
    tool_timeout: 30,
    auto_connect: true,
    log_level: "debug",
    workspace: {
      root: workspaceDir,
      name: "live-mcp-e2e",
      allow_outside_with_confirmation: false,
    },
  };
  const policy = {
    version: 2,
    profile: "dev",
    profile_locked: false,
    allowed_directories: [workspaceDir],
    trusted_directories: [workspaceDir],
    trusted_read_directories: [workspaceDir],
    trusted_write_directories: [workspaceDir],
    denied_directories: [],
    protected_paths: [],
    protected_path_policy: "deny_write",
    path_rules: { symlink_mode: "deny_escape", allow_dotdot: false },
    blocked_commands: ["rm -rf", "sudo", "shutdown", "reboot", "poweroff", "init", "dd", "mkfs"],
    require_confirmation: [],
    read_only: false,
    read_only_mode: "fs_read",
    allow_browser: false,
    allow_terminal: true,
    allow_computer_use: false,
    allow_secret_injection: false,
    allow_plugins: false,
    require_plugin_integrity: false,
    command_mode: "blocklist",
    allowed_commands: [],
    terminal_mode: "blocklist",
    network: { allow_browser_hosts: [], deny_browser_hosts: [], block_shell_net_tools: false },
    max_file_read_size: 10 * 1024 * 1024,
    max_command_timeout: 60,
    budgets: {
      max_tool_calls_per_hour: 300,
      max_shell_seconds_per_hour: 600,
      max_bytes_written_per_hour: 50_000_000,
      max_confirmations_per_hour: 60,
    },
    disable_builtin_protections: false,
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(deckDir, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });

  return { home, configPath, workspaceDir, deviceToken };
}

async function main() {
  await checkWrangler();
  await buildIfNeeded();
  apiToken = ensureDevVarsApiToken();
  ensureLocalWranglerConfig();

  const local = await writeLocalConfig();

  log(`starting wrangler dev on ${BASE_URL}`);
  const wrangler = spawnManaged("wrangler", "npx", ["--no-install", "wrangler", "dev", "--local", "--port", PORT], {
    cwd: WORKER_DIR,
    env: {
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
    },
  });

  await waitFor("worker /health", WORKER_READY_TIMEOUT_MS, async () => {
    if (wrangler.child.exitCode !== null || wrangler.child.signalCode !== null) {
      fatalWait(`wrangler exited before /health was ready:\n${wrangler.output.tail()}`);
    }
    const { status, json } = await fetchJson(`${BASE_URL}/health`, { timeoutMs: 5_000 });
    return status === 200 && json.status === "ok" ? json : null;
  });
  pass("GET /health", BASE_URL);

  const registration = await workerApi("/api/devices", {
    method: "POST",
    body: JSON.stringify({
      device_id: deviceId,
      token: local.deviceToken,
      name: "deckagent-live-mcp-e2e",
      capabilities: ["filesystem", "terminal", "environment"],
    }),
  });
  assert(registration.status === 200 && registration.json.ok === true, `device registration failed: ${truncate(registration.json)}`);
  pass("POST /api/devices", `device_id=${deviceId}`);

  const preferred = await workerApi("/api/devices/prefer", {
    method: "PUT",
    body: JSON.stringify({ device_id: deviceId }),
  });
  assert(preferred.status === 200, `device prefer failed: ${truncate(preferred.json)}`);

  log("starting desktop daemon");
  const daemon = spawnManaged("daemon", "node", [DAEMON_ENTRY, "--foreground"], {
    cwd: local.workspaceDir,
    env: {
      HOME: local.home,
      DECKAGENT_CONFIG: local.configPath,
    },
  });

  await waitFor("daemon online", DAEMON_READY_TIMEOUT_MS, async () => {
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      fatalWait(`daemon exited before connecting:\n${daemon.output.tail()}`);
    }
    const { status, json } = await workerApi("/api/devices");
    const device = Array.isArray(json.devices) ? json.devices.find((entry) => entry.id === deviceId) : null;
    return status === 200 && device?.status === "online" ? device : null;
  });
  pass("daemon tunnel online");

  const initialized = await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "deckagent-live-mcp-e2e", version: "0.0.1" },
  });
  assert(initialized?.serverInfo?.name, `initialize missing serverInfo: ${truncate(initialized)}`);
  pass("MCP initialize", `${initialized.serverInfo.name} ${initialized.serverInfo.version}`);

  const tools = await mcp("tools/list", { deviceId });
  const toolNames = tools?.tools?.map((tool) => tool.name) ?? [];
  assert(toolNames.includes("get_environment"), "tools/list did not include get_environment");
  assert(toolNames.includes("list_directory"), "tools/list did not include list_directory");
  pass("MCP tools/list", `${toolNames.length} tools`);

  const resources = await mcp("resources/list", {});
  assert(Array.isArray(resources?.resources), `resources/list malformed: ${truncate(resources)}`);
  pass("MCP resources/list", `${resources.resources.length} resources`);

  const devicesResource = await mcp("resources/read", { uri: "deckagent://devices", deviceId });
  const devicesText = devicesResource?.contents?.[0]?.text ?? "";
  assert(devicesText.includes(deviceId), `deckagent://devices did not include test device: ${truncate(devicesText)}`);
  pass("MCP resources/read deckagent://devices", truncate(devicesText, 160));

  const envResult = await mcp("tools/call", {
    name: "get_environment",
    arguments: {},
    deviceId,
  });
  assert(envResult?.isError !== true, `get_environment returned error: ${truncate(envResult)}`);
  const envText = toolText(envResult);
  assert(envText.includes("Platform") || envText.includes("platform"), `unexpected get_environment output: ${truncate(envText)}`);
  pass("MCP tools/call get_environment", truncate(envText, 160));

  const listResult = await mcp("tools/call", {
    name: "list_directory",
    arguments: { path: "." },
    deviceId,
  });
  assert(listResult?.isError !== true, `list_directory returned error: ${truncate(listResult)}`);
  const listText = toolText(listResult);
  assert(listText.includes("README.txt"), `list_directory did not show README.txt: ${truncate(listText)}`);
  pass('MCP tools/call list_directory "."', truncate(listText, 160));

  if (toolNames.includes("start_job") && toolNames.includes("get_job")) {
    const startResult = await mcp("tools/call", {
      name: "start_job",
      arguments: {
        command: "printf deckagent-job-ok",
        cwd: ".",
        timeout_ms: 30_000,
      },
      deviceId,
    });
    assert(startResult?.isError !== true, `start_job returned error: ${truncate(startResult)}`);
    const startJson = parseToolJson(startResult, "start_job");
    assert(typeof startJson.job_id === "string", `start_job missing job_id: ${truncate(startJson)}`);
    pass("MCP tools/call start_job", `job_id=${startJson.job_id}`);

    const job = await waitFor("background job output", 30_000, async () => {
      const getResult = await mcp("tools/call", {
        name: "get_job",
        arguments: { job_id: startJson.job_id, tail_lines: 20 },
        deviceId,
      });
      assert(getResult?.isError !== true, `get_job returned error: ${truncate(getResult)}`);
      const getJson = parseToolJson(getResult, "get_job");
      return getJson.stdout?.includes("deckagent-job-ok") ? getJson : null;
    });
    pass("MCP tools/call get_job", `status=${job.status} stdout=${truncate(job.stdout, 80)}`);
  } else {
    log("start_job/get_job not advertised; skipping background job exercise.");
  }

  log("live MCP E2E passed");
}

main()
  .then(async () => {
    await cleanup();
  })
  .catch(async (err) => {
    console.error(`[live-mcp-e2e] FAIL ${err instanceof Error ? err.message : String(err)}`);
    for (const entry of children) {
      const tail = entry.output.tail();
      if (tail) console.error(`[live-mcp-e2e] ${entry.name} tail:\n${tail}`);
    }
    await cleanup();
    process.exit(1);
  });
