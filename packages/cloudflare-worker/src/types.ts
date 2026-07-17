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
}

export interface AuthOkMessage {
  type: "auth_ok";
  session_id: string;
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
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
}

export interface ToolErrorMessage {
  type: "tool_error";
  id: string;
  error: { code: string; message: string };
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
  | HeartbeatMessage
  | HeartbeatAckMessage
  | StateUpdateMessage;
