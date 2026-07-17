import type {
  Env,
  TunnelMessage,
  ExecuteToolMessage,
  ToolResultMessage,
  ToolErrorMessage,
  HeartbeatMessage,
} from "./types.js";
import { authenticateDevice, updateDeviceStatus } from "./device-registry.js";

const TOOL_TIMEOUT_MS = 60_000;

// Hard-coded tool list mirroring @deckagent/mcp-server.
const tools = [
  {
    name: "read_file",
    description: "Read the complete contents of a file from the local filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start from (1-indexed)", default: 1 },
        limit: { type: "number", description: "Maximum lines to read", default: 500, maximum: 5000 },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it if needed. OVERWRITES existing content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Surgical find-and-replace edit on a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "search_files",
    description: "Search file contents using ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", default: "~" },
        file_glob: { type: "string" },
        max_results: { type: "number", default: 50, maximum: 200 },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories in a path with metadata.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "create_directory",
    description: "Create a directory and all parent directories.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read_multiple_files",
    description: "Read up to 10 files in one call.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
  },
  {
    name: "execute_command",
    description: "Execute a shell command and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
        timeout: { type: "number", default: 60, maximum: 300 },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["command"],
    },
  },
  {
    name: "execute_command_stream",
    description: "Execute a command and stream output back in real-time.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
  },
  {
    name: "list_processes",
    description: "List running processes on the system.",
    inputSchema: { type: "object", properties: { filter: { type: "string" } } },
  },
  {
    name: "kill_process",
    description: "Kill a process by PID. Requires confirmation by default.",
    inputSchema: { type: "object", properties: { pid: { type: "number" }, signal: { type: "string", default: "SIGTERM" } }, required: ["pid"] },
  },
  {
    name: "browser_navigate",
    description: "Open a URL in the browser.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, headless: { type: "boolean", default: true } }, required: ["url"] },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current browser page.",
    inputSchema: { type: "object", properties: { full_page: { type: "boolean", default: false } } },
  },
  {
    name: "browser_click",
    description: "Click an element on the page by selector.",
    inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  },
  {
    name: "browser_evaluate",
    description: "Run JavaScript code in the browser page context.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "get_environment",
    description: "Get system environment information.",
    inputSchema: { type: "object", properties: {} },
  },
];

interface PendingTool {
  resolve: (value: { type: "tool_result"; result?: { content: Array<{ type: string; text: string }>; isError?: boolean } } | { type: "tool_error"; error: { code: string; message: string } }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TunnelDO implements DurableObject {
  private ws: WebSocket | null = null;
  private deviceId: string | null = null;
  private sessionId: string | null = null;
  private pendingTools = new Map<string, PendingTool>();
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.env = env;
    // ctx is intentionally unused; DO lifetime is kept alive by the WebSocket.
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (pathname === "/mcp") {
      return this.handleMcpRequest(request);
    }

    return new Response(
      JSON.stringify({ connected: this.ws !== null, deviceId: this.deviceId }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    server.addEventListener("message", async (event) => {
      try {
        const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const msg = JSON.parse(trimmed) as TunnelMessage;
          await this.handleTunnelMessage(server, msg);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Invalid message";
        server.send(JSON.stringify({ type: "auth_error", reason }) + "\n");
      }
    });

    server.addEventListener("close", () => {
      this.cleanupWebSocket();
    });

    server.addEventListener("error", () => {
      this.cleanupWebSocket();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleTunnelMessage(server: WebSocket, msg: TunnelMessage): Promise<void> {
    switch (msg.type) {
      case "auth": {
        const device = await authenticateDevice(this.env, msg.device_id, msg.token);
        if (!device) {
          server.send(JSON.stringify({ type: "auth_error", reason: "Invalid device credentials" }) + "\n");
          server.close(1008, "Authentication failed");
          return;
        }
        this.ws = server;
        this.deviceId = msg.device_id;
        this.sessionId = crypto.randomUUID();
        await updateDeviceStatus(this.env, msg.device_id, "online");
        server.send(JSON.stringify({ type: "auth_ok", session_id: this.sessionId }) + "\n");
        break;
      }
      case "tool_result": {
        this.resolveToolResult(msg.id, { type: "tool_result", result: msg.result });
        break;
      }
      case "tool_error": {
        this.resolveToolResult(msg.id, { type: "tool_error", error: msg.error });
        break;
      }
      case "heartbeat": {
        if (this.deviceId) {
          await updateDeviceStatus(this.env, this.deviceId, "online");
        }
        server.send(JSON.stringify({ type: "heartbeat_ack" }) + "\n");
        break;
      }
      default:
        // Ignore unknown message types.
        break;
    }
  }

  private cleanupWebSocket(): void {
    if (this.deviceId) {
      // Intentionally not awaited; best-effort status update.
      updateDeviceStatus(this.env, this.deviceId, "offline").catch(() => {});
    }
    for (const pending of this.pendingTools.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket disconnected"));
    }
    this.pendingTools.clear();
    this.ws = null;
    this.deviceId = null;
    this.sessionId = null;
  }

  private resolveToolResult(
    id: string,
    value: { type: "tool_result"; result?: { content: Array<{ type: string; text: string }>; isError?: boolean } } | { type: "tool_error"; error: { code: string; message: string } }
  ): void {
    const pending = this.pendingTools.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(value);
    this.pendingTools.delete(id);
  }

  private async handleMcpRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return jsonRpcResponse("0", { tools });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body: { method?: string; id?: string | number | null; params?: { name?: string; arguments?: Record<string, unknown>; deviceId?: string } };
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(null, "INVALID_ARGUMENTS", "Invalid JSON body", 400);
    }

    const method = body.method ?? "";
    const id = body.id ?? null;

    if (method === "initialize") {
      return jsonRpcResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "DeckAgent", version: "0.1.0" },
      });
    }

    if (method === "tools/list") {
      return jsonRpcResponse(id, { tools });
    }

    if (method === "tools/call") {
      const toolName = body.params?.name;
      const toolArgs = body.params?.arguments ?? {};
      const deviceId = body.params?.deviceId ?? "default";

      if (!toolName || !tools.some((t) => t.name === toolName)) {
        return jsonRpcError(id, "TOOL_NOT_FOUND", `Tool '${toolName}' not found`, 404);
      }

      if (!this.ws || !this.deviceId) {
        return jsonRpcError(id, "DEVICE_OFFLINE", "No daemon connected", 503);
      }

      const requestId = crypto.randomUUID();
      const executeMsg: ExecuteToolMessage = {
        type: "execute_tool",
        id: requestId,
        tool: toolName,
        args: toolArgs,
      };

      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingTools.delete(requestId);
          resolve(jsonRpcError(id, "TOOL_TIMEOUT", "Tool execution timed out", 504));
        }, TOOL_TIMEOUT_MS);

        this.pendingTools.set(requestId, {
          resolve: (value) => {
            if (value.type === "tool_error") {
              resolve(jsonRpcError(id, value.error.code, value.error.message, value.error.code === "DEVICE_OFFLINE" ? 503 : 500));
            } else {
              resolve(jsonRpcResponse(id, value.result));
            }
          },
          reject: () => {
            resolve(jsonRpcError(id, "DEVICE_OFFLINE", "Daemon disconnected while executing tool", 503));
          },
          timer,
        });

        try {
          this.ws!.send(JSON.stringify(executeMsg) + "\n");
        } catch {
          this.pendingTools.delete(requestId);
          clearTimeout(timer);
          resolve(jsonRpcError(id, "DEVICE_OFFLINE", "Failed to send tool request to daemon", 503));
        }
      });
    }

    return jsonRpcError(id, "METHOD_NOT_FOUND", `Method '${method}' not supported`, 404);
  }
}

function jsonRpcResponse(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(
  id: string | number | null,
  code: string,
  message: string,
  status = 500
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
