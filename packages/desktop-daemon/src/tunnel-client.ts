import WebSocket from "ws";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { ToolExecutor } from "./tool-executor.js";
import { readLocalResource } from "./resources.js";
import { DAEMON_VERSION, PROTOCOL_VERSION } from "./version.js";
import {
  buildDaemonHealth,
  writeDaemonHealth,
  type HealthTunnelState,
} from "./health.js";
import { recordReconnectMetric } from "./metrics.js";
import {
  sendDesktopNotification,
  type DesktopNotifier,
} from "./notify.js";

interface ExecuteToolMessage {
  type: "execute_tool";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ReadResourceMessage {
  type: "read_resource";
  id: string;
  uri: string;
  args?: Record<string, unknown>;
}

const AuthOkMessageSchema = z
  .object({
    type: z.literal("auth_ok"),
    session_id: z.string().min(1),
    worker_version: z.string().min(1),
    min_protocol_version: z.number().int().nonnegative(),
    server_time: z.number(),
    warning: z.string().min(1).optional(),
  })
  .strict();

type AuthOkMessage = z.infer<typeof AuthOkMessageSchema>;

/** Payload sent as tunnel `policy_caps` for Worker tools/list filtering. */
export type PolicyCapsPayload = {
  tools: string[];
  tool_catalog?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  capabilities?: {
    fs_read?: boolean;
    fs_write?: boolean;
    terminal?: boolean;
    browser?: boolean;
    meta?: boolean;
    [key: string]: boolean | undefined;
  };
  read_only?: boolean;
  profile?: string;
};

export type ConnectionState =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "connected";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEARTBEAT_ACK_TIMEOUT_MS = 45000;
const HEARTBEAT_GRACE_MS = 2000;
const DISCONNECT_NOTIFY_DEBOUNCE_MS = 60 * 1000;

export class TunnelClient {
  private ws: WebSocket | null = null;
  private config: Config;
  private executor: ToolExecutor;
  private logger: Logger;
  private getCaps: (() => PolicyCapsPayload) | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private shouldReconnect = true;
  private pendingAuth: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private state: ConnectionState = "stopped";
  private bufferedData = "";
  private lastHeartbeatAt: Date | null = null;
  private workerVersion: string | undefined;
  private protocolWarning: string | undefined;
  private healthPath: string | undefined;
  private notifier: DesktopNotifier;
  private now: () => number;
  private disconnectNotifyDebounceMs: number;
  private disconnectedSinceLastConnect = false;
  private lastDisconnectNotifyAt: number | null = null;
  private connectedAt: Date | null = null;
  private lastDisconnectAt: Date | null = null;
  private lastDisconnectReason: string | null = null;
  private reconnectAttempt = 0;
  private nextReconnectAt: Date | null = null;

  constructor(
    config: Config,
    executor: ToolExecutor,
    logger: Logger,
    options?: {
      getCaps?: () => PolicyCapsPayload;
      healthPath?: string;
      notifier?: DesktopNotifier;
      now?: () => number;
      disconnectNotifyDebounceMs?: number;
    },
  ) {
    this.config = config;
    this.executor = executor;
    this.logger = logger;
    this.getCaps = options?.getCaps ?? null;
    this.healthPath = options?.healthPath;
    this.notifier = options?.notifier ?? sendDesktopNotification;
    this.now = options?.now ?? Date.now;
    this.disconnectNotifyDebounceMs =
      options?.disconnectNotifyDebounceMs ?? DISCONNECT_NOTIFY_DEBOUNCE_MS;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getStatusSnapshot(): {
    last_heartbeat_at: string | null;
    worker_version: string | null;
    protocol_warning: string | null;
    reconnecting: boolean;
  } {
    return {
      last_heartbeat_at: this.lastHeartbeatAt?.toISOString() ?? null,
      worker_version: this.workerVersion ?? null,
      protocol_warning: this.protocolWarning ?? null,
      reconnecting:
        this.reconnectTimer !== null ||
        (this.disconnectedSinceLastConnect &&
          (this.state === "connecting" || this.state === "authenticating")),
    };
  }

  /**
   * Re-send policy_caps to the Worker (e.g. after Control UI policy POST).
   * No-op when not connected or getCaps was not provided.
   */
  refreshCaps(): void {
    if (this.state !== "connected") return;
    this.sendPolicyCaps();
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "connected") {
      return;
    }
    this.nextReconnectAt = null;
    this.setState("connecting");
    this.shouldReconnect = true;
    this.bufferedData = "";

    const url = new URL("/tunnel", this.config.worker_url);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }
    // Multi-device Durable Objects route by device_id query param.
    url.searchParams.set("device_id", this.config.device_id);

    this.logger.info(`Connecting to WebSocket tunnel: ${url.toString()}`);

    try {
      this.ws = new WebSocket(url.toString());
    } catch (err) {
      this.logger.error(
        `Failed to create WebSocket: ${humanError(err)}`,
      );
      this.recordTunnelDisconnected(`websocket_create_failed: ${humanError(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (data) => this.onMessageData(data));
    this.ws.on("close", (code, reason) => this.onClose(code, reason));
    this.ws.on("error", (err) => this.onError(err));
  }

  disconnect(): void {
    this.logger.info("Disconnecting WebSocket tunnel");
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.nextReconnectAt = null;
    this.stopHeartbeat();
    this.stopHeartbeatTimeout();

    this.executor.abortAll();

    this.pendingAuth?.reject(new Error("Disconnected"));
    this.pendingAuth = null;

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.send({ type: "close", reason: "daemon_shutdown" });
        } catch {
          // Best-effort; socket may already be closing.
        }
        this.ws.close(1000, "daemon_shutdown");
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }

    this.setState("stopped");
    this.recordTunnelDisconnected("daemon_shutdown");
    this.writeHealth("disconnected", false);
  }

  private onOpen(): void {
    this.logger.info("WebSocket open; sending auth");
    this.nextReconnectAt = null;
    this.setState("authenticating");
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.clearReconnectTimer();
    this.send({
      type: "auth",
      device_id: this.config.device_id,
      token: this.config.token,
      daemon_version: DAEMON_VERSION,
      protocol_version: PROTOCOL_VERSION,
    });
  }

  private onMessageData(data: WebSocket.RawData): void {
    const chunk = data.toString("utf-8");
    this.bufferedData += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.bufferedData.indexOf("\n")) !== -1) {
      const line = this.bufferedData.slice(0, newlineIndex);
      this.bufferedData = this.bufferedData.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      this.onMessageLine(line);
    }
  }

  private onMessageLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(`Received invalid JSON line: ${humanError(err)}`);
      return;
    }

    const type = msg.type;
    if (typeof type !== "string") {
      this.logger.warn("Received message without type field");
      return;
    }

    this.logger.debug(`Received message type: ${type}`);

    switch (type) {
      case "auth_ok":
        this.handleAuthOk(msg);
        break;
      case "auth_error":
        this.handleAuthError(msg);
        break;
      case "heartbeat_ack":
        this.handleHeartbeatAck();
        break;
      case "execute_tool": {
        const parsed = parseExecuteTool(msg);
        if (!parsed) {
          this.logger.warn("Received malformed execute_tool message");
          return;
        }
        this.executeTool(parsed).catch((err) => {
          this.logger.error(
            `Unhandled execute_tool error: ${humanError(err)}`,
          );
        });
        break;
      }
      case "read_resource": {
        const parsed = parseReadResource(msg);
        if (!parsed) {
          this.logger.warn("Received malformed read_resource message");
          return;
        }
        this.handleReadResource(parsed);
        break;
      }
      default:
        this.logger.warn(`Received unknown message type: ${type}`);
    }
  }

  private handleAuthOk(raw: Record<string, unknown>): void {
    const parsed = AuthOkMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const message = `Malformed auth_ok from Worker: ${parsed.error.message}`;
      this.logger.error(message);
      this.protocolWarning = message;
      this.pendingAuth?.reject(new Error(message));
      this.pendingAuth = null;
      this.shouldReconnect = false;
      this.recordTunnelDisconnected("malformed_auth_ok");
      this.ws?.close(1002, "malformed_auth_ok");
      this.writeHealth("disconnected", false);
      return;
    }

    const msg: AuthOkMessage = parsed.data;
    this.workerVersion = msg.worker_version;
    this.protocolWarning = msg.warning;

    if (msg.min_protocol_version > PROTOCOL_VERSION) {
      const message =
        `Worker ${msg.worker_version} requires tunnel protocol ` +
        `${msg.min_protocol_version}, but this daemon supports ${PROTOCOL_VERSION}. ` +
        "Upgrade DeckAgent before reconnecting.";
      this.logger.error(message);
      this.protocolWarning = message;
      this.pendingAuth?.reject(new Error(message));
      this.pendingAuth = null;
      this.shouldReconnect = false;
      this.stopHeartbeat();
      this.stopHeartbeatTimeout();
      this.recordTunnelDisconnected("protocol_version_unsupported");
      this.writeHealth("disconnected", false);
      this.ws?.close(1002, "protocol_version_unsupported");
      return;
    }

    if (msg.warning) {
      this.logger.warn(`Worker compatibility warning: ${msg.warning}`);
    }

    this.logger.info("Authentication successful");
    const shouldNotifyReconnect = this.disconnectedSinceLastConnect;
    this.connectedAt = new Date(this.now());
    this.reconnectAttempt = 0;
    this.nextReconnectAt = null;
    this.setState("connected");
    if (shouldNotifyReconnect) {
      this.notify(
        "DeckAgent reconnected",
        `Tunnel reconnected to ${this.config.worker_url}`,
      );
      this.disconnectedSinceLastConnect = false;
    }
    this.pendingAuth?.resolve();
    this.pendingAuth = null;
    this.startHeartbeat();
    // S2: publish enabled tools so Worker can filter tools/list.
    this.sendPolicyCaps();
  }

  private sendPolicyCaps(): void {
    if (!this.getCaps) return;
    let caps: PolicyCapsPayload;
    try {
      caps = this.getCaps();
    } catch (err) {
      this.logger.warn(
        `Failed to collect policy caps: ${humanError(err)}`,
      );
      return;
    }
    if (!Array.isArray(caps.tools)) {
      this.logger.warn("policy_caps getCaps() returned invalid tools array");
      return;
    }
    this.send({
      type: "policy_caps",
      tools: caps.tools,
      tool_catalog: caps.tool_catalog,
      capabilities: caps.capabilities,
      read_only: caps.read_only,
      profile: caps.profile,
    });
    this.logger.debug(
      `Sent policy_caps (${caps.tools.length} tools, read_only=${String(caps.read_only)})`,
    );
  }

  private handleAuthError(msg: Record<string, unknown>): void {
    const reason =
      typeof msg.reason === "string" ? msg.reason : "unknown";
    this.logger.error(`Authentication failed: ${reason}`);
    this.pendingAuth?.reject(new Error(`Authentication failed: ${reason}`));
    this.pendingAuth = null;
    this.shouldReconnect = false;
    this.recordTunnelDisconnected(`auth_failed: ${reason}`);
    this.ws?.close(1008, "auth_failed");
  }

  private handleHeartbeatAck(): void {
    this.logger.debug("Heartbeat acknowledged");
    this.stopHeartbeatTimeout();
    this.lastHeartbeatAt = new Date();
    this.writeHealth();
  }

  private onClose(code: number, reason: Buffer): void {
    const wasConnected = this.state === "connected";
    const reasonText = reason.toString("utf-8") || String(code);
    this.logger.warn(`WebSocket closed: ${code} ${reasonText}`);
    this.recordTunnelDisconnected(reasonText);
    this.ws = null;
    this.pendingAuth?.reject(new Error(`WebSocket closed: ${code}`));
    this.pendingAuth = null;
    this.stopHeartbeat();
    this.stopHeartbeatTimeout();

    this.executor.abortAll();

    this.setState("stopped");
    if (wasConnected) {
      this.markTunnelDisconnected(reasonText);
    }

    if (this.shouldReconnect && code !== 1008) {
      this.scheduleReconnect();
    }
  }

  private onError(err: Error): void {
    this.logger.error(`WebSocket error: ${humanError(err)}`);
    this.recordTunnelDisconnected(`websocket_error: ${humanError(err)}`);
    this.pendingAuth?.reject(err);
    this.pendingAuth = null;
    this.ws?.terminate();
    this.ws = null;
    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `Cannot send ${message.type}; WebSocket not open`,
      );
      return;
    }
    const line = JSON.stringify(message) + "\n";
    this.ws.send(line, (err) => {
      if (err) {
        this.logger.error(`WebSocket send error: ${humanError(err)}`);
      }
    });
  }

  private sendHeartbeat(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    this.send({
      type: "heartbeat",
      timestamp: Date.now(),
    });

    this.stopHeartbeatTimeout();
    this.heartbeatTimeoutTimer = setTimeout(() => {
      this.logger.warn("Heartbeat timeout; reconnecting");
      this.recordTunnelDisconnected("heartbeat_timeout");
      this.ws?.terminate();
      this.ws = null;
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }, HEARTBEAT_ACK_TIMEOUT_MS);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs =
      (this.config.heartbeat_interval ?? 15) * 1000 - HEARTBEAT_GRACE_MS;
    const safeIntervalMs = Math.max(1000, intervalMs);
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      safeIntervalMs,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (!this.shouldReconnect) return;
    if (this.state === "connecting" || this.state === "connected") {
      this.setState("stopped");
    }

    const delayMs = this.reconnectDelay;
    this.reconnectAttempt += 1;
    this.nextReconnectAt = new Date(this.now() + delayMs);
    this.logger.info(`Reconnecting in ${delayMs}ms`);
    recordReconnectMetric();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        delayMs * 2,
        MAX_RECONNECT_DELAY_MS,
      );
      this.connect();
    }, delayMs);
    this.writeHealth("connecting", false);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.writeHealth();
  }

  private markTunnelDisconnected(reason: string): void {
    this.disconnectedSinceLastConnect = true;
    const now = this.now();
    if (
      this.lastDisconnectNotifyAt !== null &&
      now - this.lastDisconnectNotifyAt < this.disconnectNotifyDebounceMs
    ) {
      return;
    }
    this.lastDisconnectNotifyAt = now;
    this.notify(
      "DeckAgent disconnected",
      `Tunnel disconnected from ${this.config.worker_url}: ${reason}`,
    );
  }

  private recordTunnelDisconnected(reason: string): void {
    this.connectedAt = null;
    this.lastDisconnectAt = new Date(this.now());
    this.lastDisconnectReason = reason;
  }

  private notify(title: string, body: string): void {
    try {
      this.notifier(title, body);
    } catch {
      // Notifications are best-effort and must not affect reconnect logic.
    }
  }

  private writeHealth(
    tunnel = this.currentHealthTunnelState(),
    ok = tunnel === "connected",
  ): void {
    try {
      writeDaemonHealth(
        buildDaemonHealth(this.config, tunnel, {
          ok,
          lastHeartbeatAt: this.lastHeartbeatAt ?? undefined,
          workerVersion: this.workerVersion,
          protocolWarning: this.protocolWarning,
          connectedAt: this.connectedAt,
          lastDisconnectAt: this.lastDisconnectAt,
          lastDisconnectReason: this.lastDisconnectReason,
          reconnectAttempt: this.reconnectAttempt,
          nextReconnectAt: this.nextReconnectAt,
        }),
        this.healthPath,
      );
    } catch (err) {
      this.logger.warn(`Failed to write daemon health: ${humanError(err)}`);
    }
  }

  private currentHealthTunnelState(): HealthTunnelState {
    switch (this.state) {
      case "connected":
        return "connected";
      case "connecting":
      case "authenticating":
        return "connecting";
      case "stopped":
        return this.shouldReconnect && this.reconnectTimer
          ? "connecting"
          : "disconnected";
    }
  }

  private async executeTool(msg: ExecuteToolMessage): Promise<void> {
    const outcome = await this.executor.execute(msg.id, msg.tool, msg.args, {
      source: "tunnel",
      onProgress: (chunk) => {
        this.send({
          type: "tool_progress",
          id: msg.id,
          chunk,
        });
      },
    });

    if (outcome.ok) {
      this.send({
        type: "tool_result",
        id: msg.id,
        result: {
          content: outcome.result.content,
          isError: outcome.result.isError,
        },
      });
      return;
    }

    this.send({
      type: "tool_error",
      id: msg.id,
      error: {
        code: outcome.code,
        message: outcome.message,
      },
    });
  }

  private handleReadResource(msg: ReadResourceMessage): void {
    const result = readLocalResource(msg.uri, msg.args, {
      policy: this.executor.getPolicy(),
      workspace: this.executor.getWorkspace() ?? this.config.workspace,
      auditLogDir: this.executor.getAuditLogDir(),
    });

    if (result.ok) {
      this.send({
        type: "resource_result",
        id: msg.id,
        contents: result.contents,
      });
      return;
    }

    this.send({
      type: "resource_error",
      id: msg.id,
      error: {
        code: result.code,
        message: result.message,
      },
    });
  }
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseExecuteTool(
  msg: Record<string, unknown>,
): ExecuteToolMessage | null {
  if (
    typeof msg.id === "string" &&
    typeof msg.tool === "string" &&
    msg.args !== null &&
    typeof msg.args === "object"
  ) {
    return {
      type: "execute_tool",
      id: msg.id,
      tool: msg.tool,
      args: msg.args as Record<string, unknown>,
    };
  }
  return null;
}

function parseReadResource(
  msg: Record<string, unknown>,
): ReadResourceMessage | null {
  if (typeof msg.id !== "string" || typeof msg.uri !== "string") {
    return null;
  }
  const args =
    msg.args !== null && typeof msg.args === "object"
      ? (msg.args as Record<string, unknown>)
      : undefined;
  return {
    type: "read_resource",
    id: msg.id,
    uri: msg.uri,
    args,
  };
}
