import WebSocket from "ws";
import type { ToolRegistry } from "@deckagent/mcp-server";
import type { Config } from "./config.js";
import type { Policy, PolicyResult } from "./policy.js";
import type { Logger } from "./logger.js";
import { checkToolAllowed } from "./policy.js";

interface ExecuteToolMessage {
  type: "execute_tool";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ToolResultPayload {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export type ConnectionState =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "connected";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEARTBEAT_ACK_TIMEOUT_MS = 45000;
const HEARTBEAT_GRACE_MS = 2000;

export class TunnelClient {
  private ws: WebSocket | null = null;
  private config: Config;
  private toolRegistry: ToolRegistry;
  private policy: Policy;
  private logger: Logger;
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
  private activeExecutions = new Map<string, AbortController>();
  private bufferedData = "";

  constructor(
    config: Config,
    toolRegistry: ToolRegistry,
    policy: Policy,
    logger: Logger,
  ) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.policy = policy;
    this.logger = logger;
  }

  getState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "connected") {
      return;
    }
    this.state = "connecting";
    this.shouldReconnect = true;
    this.bufferedData = "";

    const url = new URL("/tunnel", this.config.worker_url);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }

    this.logger.info(`Connecting to WebSocket tunnel: ${url.toString()}`);

    try {
      this.ws = new WebSocket(url.toString());
    } catch (err) {
      this.logger.error(
        `Failed to create WebSocket: ${humanError(err)}`,
      );
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
    this.stopHeartbeat();
    this.stopHeartbeatTimeout();

    for (const [id, controller] of this.activeExecutions) {
      controller.abort();
      this.activeExecutions.delete(id);
    }

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

    this.state = "stopped";
  }

  private onOpen(): void {
    this.logger.info("WebSocket open; sending auth");
    this.state = "authenticating";
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.clearReconnectTimer();
    this.send({
      type: "auth",
      device_id: this.config.device_id,
      token: this.config.token,
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
        this.handleAuthOk();
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
      default:
        this.logger.warn(`Received unknown message type: ${type}`);
    }
  }

  private handleAuthOk(): void {
    this.logger.info("Authentication successful");
    this.state = "connected";
    this.pendingAuth?.resolve();
    this.pendingAuth = null;
    this.startHeartbeat();
  }

  private handleAuthError(msg: Record<string, unknown>): void {
    const reason =
      typeof msg.reason === "string" ? msg.reason : "unknown";
    this.logger.error(`Authentication failed: ${reason}`);
    this.pendingAuth?.reject(new Error(`Authentication failed: ${reason}`));
    this.pendingAuth = null;
    this.shouldReconnect = false;
    this.ws?.close(1008, "auth_failed");
  }

  private handleHeartbeatAck(): void {
    this.logger.debug("Heartbeat acknowledged");
    this.stopHeartbeatTimeout();
  }

  private onClose(code: number, reason: Buffer): void {
    const reasonText = reason.toString("utf-8") || String(code);
    this.logger.warn(`WebSocket closed: ${code} ${reasonText}`);
    this.ws = null;
    this.pendingAuth?.reject(new Error(`WebSocket closed: ${code}`));
    this.pendingAuth = null;
    this.stopHeartbeat();
    this.stopHeartbeatTimeout();

    for (const [id, controller] of this.activeExecutions) {
      controller.abort();
      this.activeExecutions.delete(id);
    }

    this.state = "stopped";

    if (this.shouldReconnect && code !== 1008) {
      this.scheduleReconnect();
    }
  }

  private onError(err: Error): void {
    this.logger.error(`WebSocket error: ${humanError(err)}`);
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
      this.state = "stopped";
    }

    this.logger.info(
      `Reconnecting in ${this.reconnectDelay}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        MAX_RECONNECT_DELAY_MS,
      );
      this.connect();
    }, this.reconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async executeTool(msg: ExecuteToolMessage): Promise<void> {
    this.logger.info(`Executing tool: ${msg.tool}`);

    const preconfirmed = msg.args._preconfirmed === true;
    const policyResult: PolicyResult = checkToolAllowed(
      msg.tool,
      msg.args,
      this.policy,
      preconfirmed,
    );

    if (!policyResult.allowed) {
      this.send({
        type: "tool_error",
        id: msg.id,
        error: {
          code: "POLICY_BLOCKED",
          message: policyResult.reason || "Blocked by policy",
        },
      });
      return;
    }

    if (policyResult.requiresConfirmation) {
      this.send({
        type: "tool_error",
        id: msg.id,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message:
            policyResult.confirmationReason || "Confirmation required",
        },
      });
      return;
    }

    const timeout = this.resolveTimeout(msg.tool, msg.args);
    const controller = new AbortController();
    this.activeExecutions.set(msg.id, controller);

    const timeoutTimer = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      const result = (await this.runWithAbort(
        () => this.toolRegistry.execute(msg.tool, msg.args),
        controller.signal,
      )) as ToolResultPayload;

      clearTimeout(timeoutTimer);
      this.activeExecutions.delete(msg.id);

      this.send({
        type: "tool_result",
        id: msg.id,
        result: {
          content: result.content,
          isError: result.isError,
        },
      });
    } catch (err) {
      clearTimeout(timeoutTimer);
      this.activeExecutions.delete(msg.id);

      if ((err as Error).name === "AbortError") {
        this.send({
          type: "tool_error",
          id: msg.id,
          error: {
            code: "TOOL_TIMEOUT",
            message: `Tool '${msg.tool}' timed out after ${timeout}ms`,
          },
        });
      } else {
        this.send({
          type: "tool_error",
          id: msg.id,
          error: {
            code: "INTERNAL_ERROR",
            message: `Tool '${msg.tool}' failed: ${humanError(err)}`,
          },
        });
      }
    }
  }

  private runWithAbort<T>(
    fn: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }

      fn().then(resolve, reject);

      signal.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }

  private resolveTimeout(
    toolName: string,
    args: Record<string, unknown>,
  ): number {
    if (
      toolName === "execute_command" ||
      toolName === "execute_command_stream"
    ) {
      const requested =
        typeof args.timeout === "number"
          ? args.timeout * 1000
          : this.config.tool_timeout * 1000;
      return Math.min(requested, this.policy.max_command_timeout * 1000);
    }

    return this.config.tool_timeout * 1000;
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
