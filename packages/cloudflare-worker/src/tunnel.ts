/**
 * WebSocket tunnel between the Worker and desktop daemons.
 *
 * The daemon opens `wss://.../tunnel`, authenticates with its device_id/token,
 * then exchanges JSON-line-delimited messages (one JSON object per line,
 * terminated by `\n`). The MCP handler forwards tool calls to the daemon over
 * this socket via {@link executeToolOnDevice}.
 *
 * v1 is single-tenant and stateless: connections live in a module-level Map for
 * the lifetime of the Worker isolate.
 */

import { randomHex } from './auth.js';
import { updateDeviceCapabilities, updateDeviceStatus } from './device-registry.js';
import { getDevice } from './device-registry.js';
import type {
  Env,
  TunnelMessage,
  ToolResult,
} from './types.js';

/** Error thrown when a tool call cannot be delivered or completed. The `code`
 * is a SPEC §6.1 string code (e.g. DEVICE_OFFLINE, TOOL_TIMEOUT). */
export class TunnelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

interface PendingCall {
  id: string;
  tool: string;
  args: unknown;
  resolve: (result: ToolResult) => void;
  reject: (error: TunnelError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DeviceConnection {
  deviceId: string;
  socket: WebSocket;
  pending: Map<string, PendingCall>;
  authenticated: boolean;
}

const TOOL_TIMEOUT_MS = 60_000;
const MAX_QUEUE = 5;

/** Authenticated daemon connections, keyed by device_id. */
const connections = new Map<string, DeviceConnection>();

/** Tool calls queued for a device that is currently offline/reconnecting. */
const offlineQueues = new Map<string, PendingCall[]>();

function sendMessage(socket: WebSocket, message: TunnelMessage): void {
  socket.send(`${JSON.stringify(message)}\n`);
}

/** Device ids with a live, authenticated connection. */
export function getConnectedDeviceIds(): string[] {
  return Array.from(connections.values())
    .filter((c) => c.authenticated)
    .map((c) => c.deviceId);
}

/** Handle the `GET /tunnel` WebSocket upgrade. */
export function handleTunnel(request: Request, env: Env): Response {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected a WebSocket upgrade request', { status: 426 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const clientIp = request.headers.get('CF-Connecting-IP') ?? '';
  setupSocket(server, env, clientIp);

  return new Response(null, { status: 101, webSocket: client });
}

function setupSocket(socket: WebSocket, env: Env, clientIp: string): void {
  let buffer = '';
  let connection: DeviceConnection | null = null;

  const handleLine = async (line: string): Promise<void> => {
    let message: TunnelMessage;
    try {
      message = JSON.parse(line) as TunnelMessage;
    } catch {
      sendMessage(socket, { type: 'auth_error', reason: 'Invalid JSON message' });
      return;
    }

    if (!connection || !connection.authenticated) {
      connection = await authenticate(socket, env, message, clientIp);
      return;
    }

    await dispatch(connection, env, message);
  };

  socket.addEventListener('message', (event: MessageEvent) => {
    const data =
      typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
    buffer += data;

    void (async () => {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) await handleLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
      // Tolerate frames that carry a complete JSON object without a trailing
      // newline (buffer stays intact until the object parses cleanly).
      const remainder = buffer.trim();
      if (remainder && isCompleteJson(remainder)) {
        buffer = '';
        await handleLine(remainder);
      }
    })();
  });

  const teardown = (): void => {
    if (!connection) return;
    const conn = connection;
    connections.delete(conn.deviceId);
    for (const call of conn.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new TunnelError('DEVICE_OFFLINE', 'Device disconnected before responding'));
    }
    conn.pending.clear();
    void updateDeviceStatus(env, conn.deviceId, 'offline');
  };

  socket.addEventListener('close', teardown);
  socket.addEventListener('error', teardown);
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

async function authenticate(
  socket: WebSocket,
  env: Env,
  message: TunnelMessage,
  clientIp: string,
): Promise<DeviceConnection | null> {
  if (message.type !== 'auth') {
    sendMessage(socket, { type: 'auth_error', reason: 'First message must be of type "auth"' });
    return null;
  }

  const device = await getDevice(env, message.device_id);
  if (!device || device.token !== message.token) {
    sendMessage(socket, { type: 'auth_error', reason: 'Unknown device or invalid token' });
    return null;
  }

  const connection: DeviceConnection = {
    deviceId: device.device_id,
    socket,
    pending: new Map(),
    authenticated: true,
  };
  connections.set(device.device_id, connection);

  device.status = 'online';
  device.last_seen = Date.now();
  if (clientIp) device.ip = clientIp;
  await env.DECK_KV.put(`device:${device.device_id}`, JSON.stringify(device));

  const sessionId = randomHex(16);
  sendMessage(socket, { type: 'auth_ok', session_id: sessionId });

  flushQueue(connection);
  return connection;
}

async function dispatch(
  connection: DeviceConnection,
  env: Env,
  message: TunnelMessage,
): Promise<void> {
  switch (message.type) {
    case 'tool_result': {
      const call = connection.pending.get(message.id);
      if (call) {
        clearTimeout(call.timer);
        connection.pending.delete(message.id);
        call.resolve(message.result);
      }
      break;
    }
    case 'tool_error': {
      const call = connection.pending.get(message.id);
      if (call) {
        clearTimeout(call.timer);
        connection.pending.delete(message.id);
        call.reject(new TunnelError(message.error.code, message.error.message, message.error.details));
      }
      break;
    }
    case 'heartbeat': {
      sendMessage(connection.socket, { type: 'heartbeat_ack' });
      await updateDeviceStatus(env, connection.deviceId, 'online');
      break;
    }
    case 'state_update': {
      await updateDeviceCapabilities(env, connection.deviceId, message.capabilities);
      break;
    }
    case 'text':
      // Streaming/partial output. v1 aggregates final results via tool_result,
      // so intermediate text frames are accepted but not surfaced.
      break;
    default:
      // auth / auth_ok / auth_error / execute_tool / heartbeat_ack are not
      // expected from an already-authenticated daemon; ignore them.
      break;
  }
}

function flushQueue(connection: DeviceConnection): void {
  const queued = offlineQueues.get(connection.deviceId);
  if (!queued || queued.length === 0) return;
  offlineQueues.delete(connection.deviceId);
  for (const call of queued) {
    deliver(connection, call);
  }
}

function deliver(connection: DeviceConnection, call: PendingCall): void {
  connection.pending.set(call.id, call);
  try {
    sendMessage(connection.socket, {
      type: 'execute_tool',
      id: call.id,
      tool: call.tool,
      args: call.args,
    });
  } catch {
    connection.pending.delete(call.id);
    clearTimeout(call.timer);
    call.reject(new TunnelError('DEVICE_OFFLINE', 'Failed to send tool call to device'));
  }
}

function removeQueued(deviceId: string, id: string): void {
  const queued = offlineQueues.get(deviceId);
  if (!queued) return;
  const next = queued.filter((c) => c.id !== id);
  if (next.length === 0) offlineQueues.delete(deviceId);
  else offlineQueues.set(deviceId, next);
}

/**
 * Forward a tool call to the daemon for `deviceId` and await its result.
 * Rejects with a {@link TunnelError} (`DEVICE_OFFLINE` or `TOOL_TIMEOUT`).
 */
export function executeToolOnDevice(
  deviceId: string,
  tool: string,
  args: unknown,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve, reject) => {
    const id = randomHex(8);
    const timer = setTimeout(() => {
      const conn = connections.get(deviceId);
      conn?.pending.delete(id);
      removeQueued(deviceId, id);
      reject(
        new TunnelError('TOOL_TIMEOUT', `Tool '${tool}' timed out after ${Math.round(timeoutMs / 1000)} seconds`, {
          tool,
          timeout: Math.round(timeoutMs / 1000),
        }),
      );
    }, timeoutMs);

    const call: PendingCall = { id, tool, args, resolve, reject, timer };
    const connection = connections.get(deviceId);

    if (connection && connection.authenticated) {
      deliver(connection, call);
      return;
    }

    // Device offline: queue up to MAX_QUEUE calls while it (re)connects.
    const queued = offlineQueues.get(deviceId) ?? [];
    if (queued.length >= MAX_QUEUE) {
      clearTimeout(timer);
      reject(new TunnelError('DEVICE_OFFLINE', `Device ${deviceId} is offline`, { device_id: deviceId }));
      return;
    }
    queued.push(call);
    offlineQueues.set(deviceId, queued);
  });
}
