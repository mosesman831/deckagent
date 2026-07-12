import WebSocket from 'ws';
import type { Config } from './config.js';
import type { Policy } from './policy.js';
import { ToolExecutor, type ExecuteToolRequest } from './tool-executor.js';
import { logger } from './logger.js';

const HEARTBEAT_TIMEOUT_MS = 60_000; // reconnect if no ack for this long
const MONITOR_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

/** Build the `wss://.../tunnel` URL from the configured worker URL. */
export function buildTunnelUrl(workerUrl: string): string {
  const url = new URL(workerUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = url.pathname.replace(/\/$/, '') + '/tunnel';
  return url.toString();
}

/**
 * WebSocket client that maintains an outbound connection to the Worker's
 * `/tunnel` endpoint. Handles auth, heartbeats, JSON-line-delimited framing,
 * tool execution, and reconnection with exponential backoff (SPEC §2.5, §3.4).
 */
export class TunnelClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly executor: ToolExecutor;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private lastHeartbeatAck = 0;
  private reconnectAttempts = 0;
  private stopped = false;
  private rxBuffer = '';

  constructor(
    private config: Config,
    private policy: Policy,
    executor?: ToolExecutor,
  ) {
    this.url = buildTunnelUrl(config.worker_url);
    this.executor = executor ?? new ToolExecutor(policy);
  }

  /** Open the connection (and keep it open, reconnecting as needed). */
  connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.stopped) return;
    logger.info(`Connecting to tunnel ${this.url} (attempt ${this.reconnectAttempts + 1}).`);

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      logger.info('Tunnel socket open; sending auth.');
      this.lastHeartbeatAck = Date.now();
      this.send({ type: 'auth', device_id: this.config.device_id, token: this.config.token });
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.onData(data.toString());
    });

    ws.on('close', (code: number) => {
      logger.warn(`Tunnel socket closed (code ${code}).`);
      this.teardownTimers();
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      logger.error(`Tunnel socket error: ${err.message}`);
      // 'close' fires after 'error'; reconnect is scheduled there.
    });
  }

  /** Parse newline-delimited JSON frames out of the receive buffer. */
  private onData(chunk: string): void {
    this.rxBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.rxBuffer.indexOf('\n')) !== -1) {
      const line = this.rxBuffer.slice(0, newlineIdx).trim();
      this.rxBuffer = this.rxBuffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      logger.warn(`Ignoring malformed tunnel message: ${line.slice(0, 200)}`);
      return;
    }

    switch (msg.type) {
      case 'auth_ok':
        logger.info('Tunnel authenticated.');
        this.reconnectAttempts = 0;
        this.lastHeartbeatAck = Date.now();
        this.startHeartbeat();
        this.startMonitor();
        this.sendStateUpdate();
        break;
      case 'auth_error':
        logger.error(`Tunnel auth rejected: ${String(msg.reason ?? 'unknown reason')}.`);
        // Auth failures are unlikely to self-heal; still retry with backoff.
        this.ws?.close();
        break;
      case 'heartbeat_ack':
        this.lastHeartbeatAck = Date.now();
        break;
      case 'execute_tool':
        void this.onExecuteTool(msg as unknown as ExecuteToolRequest);
        break;
      default:
        logger.debug(`Ignoring tunnel message of type '${String(msg.type)}'.`);
    }
  }

  private async onExecuteTool(request: ExecuteToolRequest): Promise<void> {
    const result = await this.executor.execute(request, this.policy);
    this.send(result);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = Math.max(1, this.config.heartbeat_interval) * 1000;
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', timestamp: Math.floor(Date.now() / 1000) });
    }, intervalMs);
  }

  private startMonitor(): void {
    this.stopMonitor();
    this.monitorTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeatAck > HEARTBEAT_TIMEOUT_MS) {
        logger.warn('No heartbeat_ack within 60s; reconnecting.');
        this.reconnect();
      }
    }, MONITOR_INTERVAL_MS);
  }

  private sendStateUpdate(): void {
    this.send({ type: 'state_update', capabilities: this.capabilities() });
  }

  private capabilities(): string[] {
    const caps: string[] = ['filesystem'];
    if (this.policy.allow_terminal) caps.push('terminal');
    if (this.policy.allow_browser) caps.push('browser');
    return caps;
  }

  /** Serialize `msg` as a single newline-terminated JSON frame and send it. */
  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg) + '\n');
  }

  private reconnect(): void {
    this.teardownTimers();
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    this.reconnectAttempts += 1;
    logger.info(`Reconnecting in ${delay}ms.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private teardownTimers(): void {
    this.stopHeartbeat();
    this.stopMonitor();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  /**
   * Gracefully disconnect: send a `disconnect` frame, stop all timers, and close
   * the socket. Safe to call multiple times.
   */
  disconnect(): void {
    this.stopped = true;
    this.teardownTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: 'disconnect' });
      this.ws.close();
    } else {
      try {
        this.ws?.terminate();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }
}
