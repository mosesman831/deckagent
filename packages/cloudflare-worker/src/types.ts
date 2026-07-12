/**
 * Shared TypeScript types for the DeckAgent Cloudflare Worker.
 *
 * `KVNamespace`, `Request`, `Response`, `WebSocket`, and `ExecutionContext`
 * are provided as globals by `@cloudflare/workers-types`.
 */

/** Worker bindings. `vars` come from wrangler.jsonc; the two secrets are set
 * via `wrangler secret put`. */
export interface Env {
  DECK_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  APP_NAME: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

// ---- OAuth / sessions ----

/** Stored at `oauth:state:{state}` for the duration of an in-flight login. */
export interface OAuthState {
  redirect_uri: string;
  code_verifier: string;
  created_at: number;
}

/** Stored at `session:{user_id}`. */
export interface Session {
  access_token: string;
  github_username: string;
  avatar_url: string;
  device_id: string | null;
  created_at: number;
}

/** Stored at `token:{access_token}` for fast bearer-token lookups. */
export interface TokenRecord {
  user_id: string;
  github_username: string;
  created_at: number;
}

/** Subset of the GitHub `/user` response we care about. */
export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

// ---- Devices ----

export type DeviceStatus = 'online' | 'offline';

/** Stored at `device:{device_id}` (no TTL). */
export interface Device {
  device_id: string;
  name: string;
  status: DeviceStatus;
  ip: string;
  last_seen: number;
  capabilities: string[];
  token: string;
}

// ---- Tool results ----

export interface ToolContentBlock {
  type: string;
  text: string;
}

export interface ToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

// ---- WebSocket tunnel protocol (JSON-line-delimited) ----

export interface AuthMessage {
  type: 'auth';
  device_id: string;
  token: string;
}

export interface AuthOkMessage {
  type: 'auth_ok';
  session_id: string;
}

export interface AuthErrorMessage {
  type: 'auth_error';
  reason: string;
}

export interface ExecuteToolMessage {
  type: 'execute_tool';
  id: string;
  tool: string;
  args: unknown;
}

export interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  result: ToolResult;
}

export interface ToolErrorMessage {
  type: 'tool_error';
  id: string;
  error: ToolError;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
}

export interface HeartbeatAckMessage {
  type: 'heartbeat_ack';
}

export interface StateUpdateMessage {
  type: 'state_update';
  capabilities: string[];
}

export interface TextMessage {
  type: 'text';
  id?: string;
  text: string;
}

/** Any message that can travel over the tunnel, in either direction. */
export type TunnelMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthErrorMessage
  | ExecuteToolMessage
  | ToolResultMessage
  | ToolErrorMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | StateUpdateMessage
  | TextMessage;

// ---- MCP JSON-RPC ----

export type JsonRpcId = string | number | null;

export interface McpRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: string | number;
    message: string;
    data?: unknown;
  };
}

/** Body accepted by `POST /api/devices`. */
export interface DeviceRegistrationRequest {
  device_id: string;
  name: string;
  token: string;
  capabilities: string[];
}
