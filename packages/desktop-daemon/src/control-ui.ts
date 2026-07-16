import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";
import type { ConfirmationServer } from "./confirmation-server.js";
import type { Policy } from "./policy.js";
import { writePolicy, getPolicyPath } from "./policy.js";
import { readRecentAuditLog } from "./audit-log.js";
import {
  UNLOCK_HEADER,
  extractUnlockToken,
  validateAndConsumeUnlockToken,
} from "./policy-lock.js";
import { readMetricsSnapshot } from "./metrics.js";

export const CONTROL_UI_HOST = "127.0.0.1";
export const CONTROL_UI_PORT = 9150;
export const CONTROL_UI_TOKEN_FILE = "ui.token";
export const CONTROL_UI_TOKEN_COOKIE = "deckagent_ui";
export const CONTROL_UI_TOKEN_HEADER = "x-deckagent-ui-token";

export interface ControlUiStatus {
  worker_url: string;
  workspace: { root: string; name: string } | null;
  daemon_version: string;
  protocol_version: number;
  online: boolean;
  connection_state: string;
  pending_approvals: number;
  last_heartbeat_at?: string | null;
  worker_version?: string | null;
  protocol_warning?: string | null;
  reconnecting?: boolean;
}

export interface ControlUiDeviceConfig {
  device_id: string;
  device_name: string;
  worker_url: string;
  api_token?: string;
  preferred_device_id?: string;
}

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<Response>;

export interface ControlUiOptions {
  logger: Logger;
  confirmationServer: ConfirmationServer;
  getStatus: () => ControlUiStatus;
  getPolicy: () => Policy;
  setPolicy: (policy: Policy) => void;
  getDeviceConfig?: () => ControlUiDeviceConfig | null;
  fetch?: FetchLike;
  host?: string;
  port?: number;
  /** Override audit log dir (tests). */
  auditLogDir?: string;
  /** Override ~/.deckagent for unlock.token (tests). */
  unlockTokenDir?: string;
  /** Override ~/.deckagent for ui.token (tests). */
  uiTokenDir?: string;
  /** Override ~/.deckagent/jobs (tests). */
  jobsDir?: string;
}

/**
 * Local control dashboard — binds 127.0.0.1 only.
 * Status / Approvals / Audit / Policy toggles.
 */
export class ControlUiServer {
  private server: Server | null = null;
  private logger: Logger;
  private confirmationServer: ConfirmationServer;
  private getStatus: () => ControlUiStatus;
  private getPolicy: () => Policy;
  private setPolicy: (policy: Policy) => void;
  private getDeviceConfig: () => ControlUiDeviceConfig | null;
  private fetchImpl: FetchLike;
  private host: string;
  private port: number;
  private auditLogDir?: string;
  private unlockTokenDir?: string;
  private uiTokenDir?: string;
  private jobsDir?: string;
  private uiToken: string | null = null;

  constructor(options: ControlUiOptions) {
    this.logger = options.logger;
    this.confirmationServer = options.confirmationServer;
    this.getStatus = options.getStatus;
    this.getPolicy = options.getPolicy;
    this.setPolicy = options.setPolicy;
    this.getDeviceConfig = options.getDeviceConfig ?? (() => null);
    this.fetchImpl = options.fetch ?? getFetch();
    this.host = options.host ?? CONTROL_UI_HOST;
    this.port = options.port ?? CONTROL_UI_PORT;
    this.auditLogDir = options.auditLogDir;
    this.unlockTokenDir = options.unlockTokenDir;
    this.uiTokenDir = options.uiTokenDir;
    this.jobsDir = options.jobsDir;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;

    // Hard reject non-loopback binds.
    if (!isLoopbackHost(this.host)) {
      throw new Error(
        `Control UI must bind to loopback only (got host '${this.host}')`,
      );
    }

    this.uiToken = ensureControlUiToken(this.uiTokenDir);

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        this.logger.error(
          `Control UI error: ${err instanceof Error ? err.message : String(err)}`,
        );
        reject(err);
      });

      server.listen(this.port, this.host, () => {
        this.server = server;
        this.logger.info(`Control UI listening on ${this.baseUrl}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const remote = req.socket.remoteAddress || "";
    if (!isLoopbackAddress(remote)) {
      this.logger.warn(`Rejected non-loopback control UI request from ${remote}`);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: loopback only\n");
      return;
    }

    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const method = (req.method || "GET").toUpperCase();

    try {
      if (method === "GET" && url.pathname === "/") {
        const headers = this.consumeBootstrapToken(url);
        sendHtml(res, 200, renderDashboard(), headers);
        return;
      }

      if (method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, this.getStatus());
        return;
      }

      if (method === "GET" && url.pathname === "/api/local/device") {
        sendJson(res, 200, localDevicePublic(this.getDeviceConfig()));
        return;
      }

      if (method === "GET" && url.pathname === "/api/local/devices") {
        const devices = await localDevicesPublic(
          this.getDeviceConfig(),
          this.fetchImpl,
        );
        sendJson(res, 200, devices);
        return;
      }

      if (method === "POST" && url.pathname === "/api/local/device/revoke") {
        if (!this.authorizeMutation(req, res)) return;
        const result = await revokeLocalDevice(
          this.getDeviceConfig(),
          this.fetchImpl,
        );
        sendJson(res, 200, result);
        return;
      }

      if (method === "GET" && url.pathname === "/api/approvals") {
        sendJson(res, 200, { pending: this.confirmationServer.listPending() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/jobs") {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 20;
        sendJson(res, 200, {
          jobs: readRecentJobs({
            jobsDir: this.jobsDir,
            limit: Number.isFinite(limit) ? limit : 20,
            tailLines: 40,
          }),
        });
        return;
      }

      const approveMatch = url.pathname.match(
        /^\/api\/approvals\/([0-9a-fA-F-]{36})\/approve$/,
      );
      const denyMatch = url.pathname.match(
        /^\/api\/approvals\/([0-9a-fA-F-]{36})\/deny$/,
      );

      if (method === "POST" && approveMatch) {
        if (!this.authorizeMutation(req, res)) return;
        const id = approveMatch[1]!;
        const ok = this.confirmationServer.approve(id);
        sendJson(res, ok ? 200 : 404, {
          ok,
          id,
          action: "approved",
        });
        return;
      }

      if (method === "POST" && denyMatch) {
        if (!this.authorizeMutation(req, res)) return;
        const id = denyMatch[1]!;
        const ok = this.confirmationServer.deny(id);
        sendJson(res, ok ? 200 : 404, {
          ok,
          id,
          action: "denied",
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/audit") {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 50;
        const text = readRecentAuditLog({
          limit: Number.isFinite(limit) ? limit : 50,
          logDir: this.auditLogDir,
        });
        const entries = text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return { raw: line };
            }
          });
        sendJson(res, 200, { entries });
        return;
      }

      if (method === "GET" && url.pathname === "/api/metrics") {
        if (!this.authorizeUiToken(req, res)) return;
        sendJson(res, 200, readMetricsSnapshot());
        return;
      }

      if (method === "GET" && url.pathname === "/api/policy") {
        sendJson(res, 200, policySubset(this.getPolicy()));
        return;
      }

      if (method === "POST" && url.pathname === "/api/policy/unlock") {
        if (!this.authorizeMutation(req, res)) return;
        const body = await readJsonBody(req);
        const token = extractUnlockToken({
          headerValue: req.headers[UNLOCK_HEADER],
          body,
        });
        if (
          !validateAndConsumeUnlockToken(token, this.unlockTokenDir)
        ) {
          sendJson(res, 403, {
            error: "Invalid or expired unlock token",
            code: "PROFILE_LOCKED",
          });
          return;
        }
        const current = this.getPolicy();
        const unlocked: Policy = { ...current, profile_locked: false };
        writePolicy(unlocked);
        this.setPolicy(unlocked);
        this.logger.info("Policy unlocked via Control UI step-up");
        sendJson(res, 200, { ok: true, ...policySubset(unlocked) });
        return;
      }

      if (method === "POST" && url.pathname === "/api/policy") {
        if (!this.authorizeMutation(req, res)) return;
        const body = await readJsonBody(req);
        const current = this.getPolicy();
        if (current.profile_locked) {
          const token = extractUnlockToken({
            headerValue: req.headers[UNLOCK_HEADER],
            body,
          });
          if (
            !validateAndConsumeUnlockToken(token, this.unlockTokenDir)
          ) {
            sendJson(res, 403, {
              error:
                "Policy changes are locked. Run `deckagent policy unlock` and retry with X-DeckAgent-Unlock.",
              code: "PROFILE_LOCKED",
            });
            return;
          }
        }
        const updated = applyPolicySubset(current, body);
        writePolicy(updated);
        this.setPolicy(updated);
        sendJson(res, 200, policySubset(updated));
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      this.logger.error(
        `Control UI request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  private consumeBootstrapToken(url: URL): Record<string, string> | undefined {
    const token = this.uiToken;
    if (!token) return undefined;
    if (!tokensMatch(url.searchParams.get("token"), token)) {
      return undefined;
    }
    return {
      "Set-Cookie": `${CONTROL_UI_TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
    };
  }

  private authorizeMutation(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.postOriginAllowed(req)) {
      sendJson(res, 403, {
        error: "Forbidden: Control UI POSTs must come from the loopback UI origin",
        code: "CSRF_ORIGIN_DENIED",
      });
      return false;
    }

    return this.authorizeUiToken(req, res);
  }

  private authorizeUiToken(req: IncomingMessage, res: ServerResponse): boolean {
    const token = this.uiToken;
    if (!token) {
      sendJson(res, 500, {
        error: "Control UI token is not initialized",
        code: "UI_TOKEN_UNAVAILABLE",
      });
      return false;
    }

    const headerToken = firstHeader(req.headers[CONTROL_UI_TOKEN_HEADER]);
    const cookieToken = parseCookie(req.headers.cookie)[CONTROL_UI_TOKEN_COOKIE];
    if (tokensMatch(headerToken, token) || tokensMatch(cookieToken, token)) {
      return true;
    }

    sendJson(res, 401, {
      error: "Unauthorized: missing or invalid Control UI token",
      code: "UI_TOKEN_REQUIRED",
    });
    return false;
  }

  private postOriginAllowed(req: IncomingMessage): boolean {
    const origin = firstHeader(req.headers.origin);
    if (!origin) return true;
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:") return false;
      if (!isLoopbackHost(url.hostname)) return false;
      const port = url.port || "80";
      return port === String(this.port);
    } catch {
      return false;
    }
  }
}

export function getControlUiTokenPath(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), ".deckagent"), CONTROL_UI_TOKEN_FILE);
}

export function ensureControlUiToken(baseDir?: string): string {
  const tokenPath = getControlUiTokenPath(baseDir);
  mkdirSync(dirname(tokenPath), { recursive: true });

  try {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (/^[0-9a-fA-F]{64,}$/.test(existing)) {
      chmodBestEffort(tokenPath);
      return existing;
    }
  } catch {
    // Missing or unreadable token; write a fresh local UI token.
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodBestEffort(tokenPath);
  return token;
}

function policySubset(policy: Policy): Record<string, unknown> {
  return {
    profile: policy.profile ?? null,
    profile_locked: policy.profile_locked,
    read_only: policy.read_only,
    allow_browser: policy.allow_browser,
    allow_terminal: policy.allow_terminal,
    command_mode: policy.command_mode,
    allow_secret_injection: policy.allow_secret_injection,
    policy_path: getPolicyPath(),
  };
}

function applyPolicySubset(
  current: Policy,
  body: Record<string, unknown>,
): Policy {
  const next = { ...current };
  if (typeof body.read_only === "boolean") next.read_only = body.read_only;
  if (typeof body.allow_browser === "boolean") {
    next.allow_browser = body.allow_browser;
  }
  if (typeof body.allow_terminal === "boolean") {
    next.allow_terminal = body.allow_terminal;
  }
  if (body.command_mode === "blocklist" || body.command_mode === "allowlist") {
    next.command_mode = body.command_mode;
  }
  if (typeof body.allow_secret_injection === "boolean") {
    next.allow_secret_injection = body.allow_secret_injection;
  }
  return next;
}

function localDevicePublic(
  config: ControlUiDeviceConfig | null,
): Record<string, unknown> {
  if (!config) {
    return {
      device_id: null,
      device_name: null,
      worker_url: null,
      preferred_device_id: null,
    };
  }
  return {
    device_id: config.device_id,
    device_name: config.device_name,
    worker_url: config.worker_url,
    preferred_device_id: config.preferred_device_id ?? null,
  };
}

async function localDevicesPublic(
  config: ControlUiDeviceConfig | null,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  if (!config) {
    return {
      source: "local",
      preferred_device_id: null,
      devices: [],
      local_device: null,
      note: "No local device config found. Run `deckagent setup` first.",
    };
  }

  const localDevice = localDevicePublic(config);
  const localFallback = (note: string): Record<string, unknown> => ({
    source: "local",
    preferred_device_id: config.preferred_device_id ?? null,
    devices: [
      {
        id: config.device_id,
        device_id: config.device_id,
        name: config.device_name,
        status: "local-config",
        worker_url: config.worker_url,
      },
    ],
    local_device: localDevice,
    note,
  });

  if (!config.api_token) {
    return localFallback(
      "Worker API token is missing from local config, so only the local device is shown.",
    );
  }

  try {
    const response = await fetchImpl(new URL("/api/devices", config.worker_url), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.api_token}`,
        Accept: "application/json",
      },
    });
    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) {
        return localFallback(
          `Could not fetch Worker devices: Worker returned HTTP ${response.status}.`,
        );
      }
    }
    const body =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    if (!response.ok) {
      return localFallback(
        `Could not fetch Worker devices: ${responseErrorMessage(response.status, body)}.`,
      );
    }
    return {
      ...body,
      source: "worker",
      preferred_device_id:
        typeof body.preferred_device_id === "string" || body.preferred_device_id === null
          ? body.preferred_device_id
          : config.preferred_device_id ?? null,
      local_device: localDevice,
    };
  } catch (err) {
    return localFallback(
      `Could not fetch Worker devices: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}

interface JobPanelEntry {
  id: string;
  command: string;
  cwd: string | null;
  status: string;
  started_at: string | null;
  updated_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
  stdout_tail: string;
  stderr_tail: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  error: string | null;
}

function readRecentJobs(options: {
  jobsDir?: string;
  limit: number;
  tailLines: number;
}): JobPanelEntry[] {
  const jobsDir = options.jobsDir ?? join(homedir(), ".deckagent", "jobs");
  const limit = Math.max(1, Math.min(Math.floor(options.limit), 20));
  if (!existsSync(jobsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(jobsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  return entries
    .map((id) => readJobEntry(jobsDir, id, options.tailLines))
    .filter((job): job is JobPanelEntry => job !== null)
    .sort((a, b) => {
      const aTime = Date.parse(a.started_at ?? a.updated_at ?? "");
      const bTime = Date.parse(b.started_at ?? b.updated_at ?? "");
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    })
    .slice(0, limit);
}

function readJobEntry(
  jobsDir: string,
  directoryName: string,
  tailLines: number,
): JobPanelEntry | null {
  const dir = join(jobsDir, directoryName);
  let raw: string;
  try {
    raw = readFileSync(join(dir, "meta.json"), "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const meta = parsed as Record<string, unknown>;
  const id = stringValue(meta.id) ?? directoryName;
  const stdoutPath = join(dir, "stdout.log");
  const stderrPath = join(dir, "stderr.log");
  return {
    id,
    command: stringValue(meta.command) ?? "(unknown command)",
    cwd: stringValue(meta.cwd),
    status: stringValue(meta.status) ?? "unknown",
    started_at: stringValue(meta.started_at),
    updated_at: stringValue(meta.updated_at),
    ended_at: stringValue(meta.ended_at),
    exit_code: numberOrNull(meta.exit_code),
    signal: stringValue(meta.signal),
    stdout_tail: readTailLines(stdoutPath, tailLines),
    stderr_tail: readTailLines(stderrPath, tailLines),
    stdout_truncated: meta.stdout_truncated === true,
    stderr_truncated: meta.stderr_truncated === true,
    error: stringValue(meta.error),
  };
}

function readTailLines(path: string, lines: number): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return "";
    const raw = readFileSync(path, "utf-8");
    return raw.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function revokeLocalDevice(
  config: ControlUiDeviceConfig | null,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  if (!config) {
    throw new Error("Device config is unavailable. Run `deckagent setup` first.");
  }
  if (!config.api_token) {
    throw new Error("Worker API token is missing from config. Run `deckagent setup` again.");
  }

  const response = await fetchImpl(
    new URL(`/api/devices/${encodeURIComponent(config.device_id)}`, config.worker_url),
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.api_token}`,
        Accept: "application/json",
      },
    },
  );

  let payload: unknown = {};
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      throw new Error(`Worker returned a non-JSON response (HTTP ${response.status}).`);
    }
  }

  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  if (!response.ok) {
    throw new Error(responseErrorMessage(response.status, body));
  }

  return {
    ok: true,
    device_id: config.device_id,
  };
}

function responseErrorMessage(status: number, payload: Record<string, unknown>): string {
  const message = payload.message;
  if (typeof message === "string" && message.trim()) return message;
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error;
  return `Worker request failed with HTTP ${status}`;
}

function getFetch(): FetchLike {
  if (typeof fetch !== "function") {
    throw new Error("Control UI device revoke requires Node.js fetch support. Use Node 18 or newer.");
  }
  return fetch;
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

function isLoopbackAddress(addr: string): boolean {
  if (!addr) return false;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "localhost") {
    return true;
  }
  // Node may report IPv4-mapped IPv6
  if (addr === "::ffff:127.0.0.1") return true;
  if (addr.startsWith("::ffff:127.")) return true;
  return false;
}

function firstHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseCookie(value: string | string[] | undefined): Record<string, string> {
  const header = firstHeader(value);
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    try {
      out[rawName] = decodeURIComponent(rawValue.join("="));
    } catch {
      out[rawName] = rawValue.join("=");
    }
  }
  return out;
}

function tokensMatch(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function chmodBestEffort(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some platforms/filesystems do not support POSIX modes.
  }
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("Body must be a JSON object");
  } catch (err) {
    if (err instanceof Error && err.message === "Body must be a JSON object") {
      throw err;
    }
    throw new Error("Invalid JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers?: Record<string, string>,
): void {
  const body = Buffer.from(html, "utf-8");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...(headers ?? {}),
  });
  res.end(body);
}

function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>DeckAgent Control</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2332;
      --border: #2d3a4d;
      --text: #e7ecf3;
      --muted: #8b9bb4;
      --accent: #3d9cf0;
      --ok: #3ecf8e;
      --deny: #e85d5d;
      --warn: #d29922;
      --code: #121820;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1a3050 0%, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      padding: 28px 32px 12px;
      border-bottom: 1px solid var(--border);
    }
    header h1 {
      margin: 0;
      font-size: 1.6rem;
      letter-spacing: -0.02em;
      font-weight: 600;
    }
    header p { margin: 6px 0 0; color: var(--muted); font-size: 0.95rem; }
    main {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 20px 32px 40px;
      max-width: 1200px;
    }
    @media (max-width: 800px) {
      main { grid-template-columns: 1fr; padding: 16px; }
    }
    section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
    }
    section h2 {
      margin: 0 0 12px;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 600;
    }
    .row { display: flex; justify-content: space-between; gap: 12px; margin: 8px 0; font-size: 0.95rem; }
    .row .label { color: var(--muted); }
    .health-strip {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 10px;
      padding: 12px;
      background: rgba(13, 17, 23, 0.55);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    @media (max-width: 800px) {
      .health-strip { grid-template-columns: 1fr 1fr; }
    }
    .health-item {
      padding: 10px 12px;
      border-radius: 8px;
      background: #111923;
      min-width: 0;
    }
    .health-item .label {
      display: block;
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 5px;
    }
    .health-item .value {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      background: #243044;
    }
    .badge.online { background: #1a3d30; color: var(--ok); }
    .badge.offline { background: #3d1a1a; color: var(--deny); }
    .badge.warn { background: #3d321a; color: var(--warn); }
    .badge.muted { color: var(--muted); }
    .approval {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .approval .tool { font-weight: 600; margin-bottom: 4px; }
    .approval .reason { color: var(--muted); font-size: 0.9rem; margin-bottom: 8px; }
    .approval .path {
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 0.75rem;
      margin: 0 0 6px;
      word-break: break-all;
    }
    .approval pre {
      background: var(--code);
      padding: 8px;
      border-radius: 6px;
      font-size: 0.75rem;
      overflow: auto;
      max-height: 120px;
      margin: 0 0 10px;
    }
    .approval pre.diff,
    pre.log-tail {
      max-height: 360px;
      color: #e7ecf3;
      border: 1px solid var(--border);
    }
    pre.log-tail {
      max-height: 180px;
      margin: 8px 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .diff-line {
      display: block;
      min-height: 1em;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      white-space: pre-wrap;
    }
    .diff-add { color: #7ee787; background: rgba(46, 160, 67, 0.16); }
    .diff-del { color: #ffa198; background: rgba(248, 81, 73, 0.14); }
    .diff-hunk { color: #a5d6ff; background: rgba(56, 139, 253, 0.12); }
    .diff-file { color: #d2a8ff; }
    .diff-more {
      margin: -4px 0 10px;
      width: auto;
      background: #243044;
      color: var(--text);
    }
    .approval-actions {
      position: sticky;
      bottom: 0;
      background: linear-gradient(180deg, rgba(26,35,50,0.88), var(--panel));
      border-top: 1px solid var(--border);
      padding-top: 10px;
      margin-top: 8px;
      z-index: 2;
    }
    .countdown {
      color: var(--warn);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      margin-left: 8px;
      font-size: 0.82rem;
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 8px 14px;
      font-size: 0.9rem;
      cursor: pointer;
      color: #fff;
    }
    button.approve { background: #1a7f37; }
    button.deny { background: #cf222e; margin-left: 8px; }
    button.revoke { background: #cf222e; margin-top: 10px; }
    button.toggle {
      background: #243044;
      color: var(--text);
      margin: 4px 0;
      width: 100%;
      text-align: left;
    }
    button.toggle.active { border: 1px solid var(--accent); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }
    th, td {
      text-align: left;
      padding: 7px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    td code {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 0.78rem;
    }
    #audit, #jobs {
      max-height: 320px;
      overflow: auto;
    }
    .filter {
      width: 100%;
      margin: 0 0 10px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #111923;
      color: var(--text);
    }
    details.job {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 10px;
      margin: 8px 0;
      background: #111923;
    }
    details.job summary { cursor: pointer; }
    .job-meta { color: var(--muted); font-size: 0.8rem; margin: 6px 0; }
    .full { grid-column: 1 / -1; }
    .empty { color: var(--muted); font-size: 0.9rem; }
  </style>
</head>
<body>
  <header>
    <h1>DeckAgent</h1>
    <p>Local control — status, approvals, audit, policy</p>
  </header>
  <main>
    <section class="full">
      <h2>Health</h2>
      <div id="health" class="health-strip">
        <div class="health-item"><span class="label">Tunnel</span><span class="value">Loading...</span></div>
      </div>
    </section>
    <section>
      <h2>Status</h2>
      <div id="status" class="empty">Loading…</div>
    </section>
    <section>
      <h2>Devices</h2>
      <div id="device" class="empty">Loading…</div>
    </section>
    <section>
      <h2>Policy</h2>
      <div id="policy" class="empty">Loading…</div>
    </section>
    <section class="full">
      <h2>Approvals</h2>
      <div id="approvals" class="empty">Loading…</div>
    </section>
    <section class="full">
      <h2>Jobs (newest 20)</h2>
      <div id="jobs" class="empty">Loading…</div>
    </section>
    <section class="full">
      <h2>Audit</h2>
      <input id="audit-filter" class="filter" placeholder="Filter by tool, outcome, code, or time"/>
      <div id="audit" class="empty">Loading…</div>
    </section>
  </main>
  <script>
    var expandedDiffs = {};
    var latestAuditEntries = [];

    async function fetchJson(path, opts) {
      const res = await fetch(path, opts);
      return res.json();
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function badge(text, cls) {
      return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
    }

    function formatRelativeTime(iso) {
      if (!iso) return "never";
      var ms = Date.now() - Date.parse(iso);
      if (!Number.isFinite(ms)) return "unknown";
      if (ms < 0) ms = 0;
      var sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + "s ago";
      var min = Math.floor(sec / 60);
      if (min < 60) return min + "m ago";
      var hr = Math.floor(min / 60);
      return hr + "h ago";
    }

    function updateCountdowns() {
      document.querySelectorAll("[data-expires]").forEach(function (el) {
        var expires = Number(el.getAttribute("data-expires"));
        if (!Number.isFinite(expires)) {
          el.textContent = "expires unknown";
          return;
        }
        var remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
        el.textContent = remaining > 0 ? "expires in " + remaining + "s" : "expired";
      });
    }

    function diffClass(line) {
      if (line.indexOf("@@") === 0) return "diff-hunk";
      if (line.indexOf("+++") === 0 || line.indexOf("---") === 0) return "diff-file";
      if (line.indexOf("+") === 0) return "diff-add";
      if (line.indexOf("-") === 0) return "diff-del";
      return "";
    }

    function renderDiff(unified, collapsed) {
      var lines = String(unified || "").split("\\n");
      var visible = collapsed && lines.length > 40 ? lines.slice(0, 40) : lines;
      return '<pre class="diff">' + visible.map(function (line) {
        var cls = diffClass(line);
        return '<span class="diff-line ' + cls + '">' + esc(line || " ") + '</span>';
      }).join("") + '</pre>';
    }

    async function refreshStatus() {
      const s = await fetchJson("/api/status");
      const online = s.online;
      var reconnecting = !!s.reconnecting || s.connection_state === "connecting" || s.connection_state === "authenticating";
      document.getElementById("health").innerHTML =
        '<div class="health-item"><span class="label">Tunnel</span><span class="value">' +
          badge(s.connection_state || "unknown", online ? "online" : (reconnecting ? "warn" : "offline")) +
        '</span></div>' +
        '<div class="health-item"><span class="label">Heartbeat</span><span class="value">' + esc(formatRelativeTime(s.last_heartbeat_at)) + '</span></div>' +
        '<div class="health-item"><span class="label">Worker version</span><span class="value">' + esc(s.worker_version || "unknown") + '</span></div>' +
        '<div class="health-item"><span class="label">Protocol</span><span class="value">' +
          (s.protocol_warning ? badge(s.protocol_warning, "warn") : badge("ok", "online")) +
        '</span></div>' +
        '<div class="health-item"><span class="label">Reconnect</span><span class="value">' +
          (reconnecting ? badge("reconnecting", "warn") : badge("idle", "muted")) +
        '</span></div>';
      document.getElementById("status").innerHTML =
        '<div class="row"><span class="label">Worker</span><span>' + esc(s.worker_url || "—") + '</span></div>' +
        '<div class="row"><span class="label">Online</span><span class="badge ' + (online ? "online" : "offline") + '">' +
          (online ? "online" : "offline") + " (" + esc(s.connection_state || "?") + ")</span></div>" +
        '<div class="row"><span class="label">Version</span><span>' + esc(s.daemon_version) + '</span></div>' +
        '<div class="row"><span class="label">Workspace</span><span>' +
          (s.workspace ? esc(s.workspace.name + " — " + s.workspace.root) : "none") +
        '</span></div>' +
        '<div class="row"><span class="label">Pending approvals</span><span>' + esc(s.pending_approvals) + '</span></div>';
    }

    async function refreshDevice() {
      const d = await fetchJson("/api/local/devices");
      const el = document.getElementById("device");
      var local = d.local_device || {};
      if (!local.device_id) {
        el.innerHTML = '<p class="empty">No local device config found.</p>';
        return;
      }
      var devices = Array.isArray(d.devices) ? d.devices : [];
      var deviceRows = devices.length
        ? '<table><thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Last seen</th></tr></thead><tbody>' +
          devices.map(function (device) {
            var id = device.id || device.device_id || "";
            return '<tr><td><code>' + esc(id) + '</code></td><td>' + esc(device.name || device.device_name || "—") +
              '</td><td>' + esc(device.status || "—") + '</td><td>' + esc(device.last_seen || device.last_seen_at || "—") + '</td></tr>';
          }).join("") + '</tbody></table>'
        : '<p class="empty">No Worker devices returned.</p>';
      el.innerHTML =
        '<div class="row"><span class="label">Local device</span><span><code>' + esc(local.device_id) + '</code></span></div>' +
        '<div class="row"><span class="label">Preferred device</span><span><code>' + esc(d.preferred_device_id || local.preferred_device_id || "none") + '</code></span></div>' +
        '<div class="row"><span class="label">Name</span><span>' + esc(local.device_name || "—") + '</span></div>' +
        '<div class="row"><span class="label">Worker</span><span>' + esc(local.worker_url || "—") + '</span></div>' +
        '<div class="row"><span class="label">Device source</span><span>' + esc(d.source || "local") + '</span></div>' +
        (d.note ? '<p class="empty">' + esc(d.note) + '</p>' : "") +
        deviceRows +
        '<button class="revoke" id="revoke-device">Revoke on Worker</button>' +
        '<p class="empty" id="device-message"></p>';
      const btn = document.getElementById("revoke-device");
      btn.addEventListener("click", async function () {
        if (!confirm("Revoke this device on the Worker? The daemon will lose registration until setup runs again.")) {
          return;
        }
        const msg = document.getElementById("device-message");
        msg.textContent = "Revoking...";
        const res = await fetch("/api/local/device/revoke", { method: "POST" });
        const body = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          msg.textContent = body.error || "Revoke failed";
          return;
        }
        msg.textContent = "Device revoked on Worker.";
      });
    }

    async function refreshApprovals() {
      const data = await fetchJson("/api/approvals");
      const pending = data.pending || [];
      const el = document.getElementById("approvals");
      if (!pending.length) {
        el.innerHTML = '<p class="empty">No pending approvals</p>';
        return;
      }
      el.innerHTML = pending.map(function (a) {
        var lines = a.diff && a.diff.unified ? String(a.diff.unified).split("\\n").length : 0;
        var collapsed = lines > 40 && !expandedDiffs[a.id];
        var preview = a.diff && a.diff.unified
          ? '<div class="path">' + esc(a.diff.path || "") + '</div>' +
            renderDiff(a.diff.unified, collapsed) +
            (lines > 40 ? '<button class="diff-more" data-expand-diff="' + esc(a.id) + '">' +
              (collapsed ? "Show more" : "Show less") + '</button>' : "")
          : '<pre>' + esc(a.argsSummary || "") + '</pre>';
        return '<div class="approval">' +
          '<div class="tool">' + esc(a.tool) + '</div>' +
          '<div class="reason">' + esc(a.reason) +
            ' <span class="countdown" data-expires="' + esc(a.expiresAt || 0) + '"></span></div>' +
          preview +
          '<div class="approval-actions">' +
            '<button class="approve" data-id="' + esc(a.id) + '" data-action="approve">Approve</button>' +
            '<button class="deny" data-id="' + esc(a.id) + '" data-action="deny">Deny</button>' +
          '</div>' +
        '</div>';
      }).join("");
      el.querySelectorAll("button[data-expand-diff]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-expand-diff");
          expandedDiffs[id] = !expandedDiffs[id];
          refreshApprovals();
        });
      });
      el.querySelectorAll("button[data-id]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          const id = btn.getAttribute("data-id");
          const action = btn.getAttribute("data-action");
          await fetch("/api/approvals/" + id + "/" + action, { method: "POST" });
          refreshApprovals();
          refreshStatus();
        });
      });
      updateCountdowns();
    }

    async function refreshJobs() {
      const data = await fetchJson("/api/jobs?limit=20");
      const jobs = data.jobs || [];
      const el = document.getElementById("jobs");
      if (!jobs.length) {
        el.innerHTML = '<p class="empty">No background jobs found.</p>';
        return;
      }
      el.innerHTML = jobs.map(function (job) {
        var statusClass = job.status === "completed" ? "online" : (job.status === "running" ? "warn" : "offline");
        var tails = "";
        if (job.stdout_tail) {
          tails += '<p class="label">stdout tail</p><pre class="log-tail">' + esc(job.stdout_tail) + '</pre>';
        }
        if (job.stderr_tail) {
          tails += '<p class="label">stderr tail</p><pre class="log-tail">' + esc(job.stderr_tail) + '</pre>';
        }
        if (!tails) tails = '<p class="empty">No stdout/stderr tail yet.</p>';
        return '<details class="job">' +
          '<summary>' + badge(job.status || "unknown", statusClass) + ' <code>' + esc(job.id) + '</code> ' + esc(job.command || "") + '</summary>' +
          '<div class="job-meta">started ' + esc(job.started_at || "unknown") +
            ' · exit ' + esc(job.exit_code === null || job.exit_code === undefined ? "—" : job.exit_code) +
            (job.signal ? ' · signal ' + esc(job.signal) : "") + '</div>' +
          (job.error ? '<p class="empty">' + esc(job.error) + '</p>' : "") +
          tails +
        '</details>';
      }).join("");
    }

    async function refreshAudit() {
      const data = await fetchJson("/api/audit?limit=50");
      latestAuditEntries = data.entries || [];
      renderAudit();
    }

    function renderAudit() {
      var filter = (document.getElementById("audit-filter").value || "").toLowerCase();
      var entries = latestAuditEntries.filter(function (entry) {
        if (!filter) return true;
        return JSON.stringify(entry).toLowerCase().indexOf(filter) !== -1;
      });
      document.getElementById("audit").innerHTML = entries.length
        ? '<table><thead><tr><th>Time</th><th>Tool</th><th>Outcome/code</th><th>Duration</th></tr></thead><tbody>' +
          entries.map(function (e) {
            var outcome = e.outcome || "—";
            var code = e.code ? " / " + e.code : "";
            return '<tr><td>' + esc(e.ts || e.time || "") + '</td><td><code>' + esc(e.tool || "") +
              '</code></td><td>' + esc(outcome + code) + '</td><td>' + esc(e.duration_ms === undefined ? "—" : e.duration_ms) + 'ms</td></tr>';
          }).join("") + '</tbody></table>'
        : '<p class="empty">No matching audit entries.</p>';
    }

    async function refreshPolicy() {
      const p = await fetchJson("/api/policy");
      const el = document.getElementById("policy");
      const locked = !!p.profile_locked;
      const toggles = [
        { key: "read_only", label: "Read only" },
        { key: "allow_browser", label: "Allow browser" },
        { key: "allow_terminal", label: "Allow terminal" },
      ];
      let html = '<div class="row"><span class="label">Profile</span><span>' +
        esc(p.profile || "—") + (locked ? ' <span class="badge offline">LOCKED</span>' : "") +
        "</span></div>";
      if (locked) {
        html += '<p class="empty">Policy is locked. Run <code>deckagent policy unlock</code> then POST /api/policy/unlock.</p>';
      }
      html += toggles.map(function (t) {
        const on = !!p[t.key];
        return '<button class="toggle' + (on ? " active" : "") + '" data-key="' + t.key + '" data-val="' + (!on) + '"' +
          (locked ? " disabled" : "") + ">" +
          t.label + ": <strong>" + (on ? "ON" : "OFF") + "</strong></button>";
      }).join("");
      html += '<div class="row" style="margin-top:12px"><span class="label">Command mode</span>' +
        '<select id="command_mode"' + (locked ? " disabled" : "") + ">" +
        '<option value="blocklist"' + (p.command_mode === "blocklist" ? " selected" : "") + '>blocklist</option>' +
        '<option value="allowlist"' + (p.command_mode === "allowlist" ? " selected" : "") + '>allowlist</option>' +
        '</select></div>';
      el.innerHTML = html;
      if (locked) return;
      el.querySelectorAll("button.toggle").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          const key = btn.getAttribute("data-key");
          const val = btn.getAttribute("data-val") === "true";
          const body = {};
          body[key] = val;
          const res = await fetch("/api/policy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            alert(err.error || "Policy update failed");
          }
          refreshPolicy();
        });
      });
      const sel = document.getElementById("command_mode");
      if (sel) {
        sel.addEventListener("change", async function () {
          const res = await fetch("/api/policy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command_mode: sel.value }),
          });
          if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            alert(err.error || "Policy update failed");
          }
          refreshPolicy();
        });
      }
    }

    async function tick() {
      try {
        await Promise.all([refreshStatus(), refreshDevice(), refreshApprovals(), refreshJobs(), refreshAudit(), refreshPolicy()]);
      } catch (e) {
        console.error(e);
      }
    }
    document.getElementById("audit-filter").addEventListener("input", renderAudit);
    tick();
    setInterval(tick, 2000);
    setInterval(updateCountdowns, 1000);
  </script>
</body>
</html>`;
}
