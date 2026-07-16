export interface Env {
  DECK_KV: KVNamespace;
  APP_NAME: string;
  API_TOKEN: string;
  TUNNEL_DO: DurableObjectNamespace;
}

export interface DeviceInfo {
  id: string;
  name: string;
  status: DeviceStatus;
  token_hash: string;
  capabilities: string[];
  last_seen: number;
}

export type DeviceStatus = "online" | "offline";

// WebSocket tunnel messages

export interface AuthMessage {
  type: "auth";
  device_id: string;
  token: string;
  /** Semver of the connecting desktop daemon (informational). */
  daemon_version?: string;
  /** Tunnel protocol version; missing ⇒ Worker accepts with upgrade warning. */
  protocol_version?: number;
}

export interface AuthOkMessage {
  type: "auth_ok";
  session_id: string;
  worker_version: string;
  min_protocol_version: number;
  /** Unix epoch milliseconds. */
  server_time: number;
  /** Present when the daemon omitted protocol_version (legacy clients). */
  warning?: "upgrade_daemon";
}

export interface AuthErrorMessage {
  type: "auth_error";
  reason: string;
}

export interface ExecuteToolMessage {
  type: "execute_tool";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  type: "tool_result";
  id: string;
  result?: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

export interface ToolErrorMessage {
  type: "tool_error";
  id: string;
  error: { code: string; message: string };
}

/** Streaming progress chunks from execute_command_stream (before final tool_result). */
export interface ToolProgressMessage {
  type: "tool_progress";
  id: string;
  chunk: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  timestamp: number;
}

export interface HeartbeatAckMessage {
  type: "heartbeat_ack";
}

export interface StateUpdateMessage {
  type: "state_update";
  capabilities?: string[];
}

export type TunnelMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthErrorMessage
  | ExecuteToolMessage
  | ToolResultMessage
  | ToolErrorMessage
  | ToolProgressMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | StateUpdateMessage;

/** JSON-RPC 2.0 standard / server error codes */
export const JsonRpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
} as const;
