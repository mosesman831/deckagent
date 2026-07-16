import type {
  Env,
  TunnelMessage,
  ExecuteToolMessage,
  ToolResultMessage,
} from "./types.js";
import { JsonRpcCode } from "./types.js";
import { TOOL_CATALOG, TOOL_NAMES } from "./tool-catalog.js";
import { authenticateDevice, updateDeviceStatus } from "./device-registry.js";

// Allow time for local confirmation UX (~90s) plus tool execution headroom.
const TOOL_TIMEOUT_MS = 180_000;

type ToolResultPayload = {
  type: "tool_result";
  result?: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
};

type ToolErrorPayload = {
  type: "tool_error";
  error: { code: string; message: string };
};

interface PendingTool {
  resolve: (value: ToolResultPayload | ToolErrorPayload) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Accumulated tool_progress chunks (e.g. execute_command_stream). */
  chunks: string[];
}

export class TunnelDO implements DurableObject {
  private ws: WebSocket | null = null;
  private deviceId: string | null = null;
  private expectedDeviceId: string | null = null;
  private sessionId: string | null = null;
  private pendingTools = new Map<string, PendingTool>();
  private env: Env;

  constructor(_ctx: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.headers.get("Upgrade") === "websocket") {
      this.expectedDeviceId = url.searchParams.get("device_id");
      return this.handleWebSocketUpgrade(request);
    }

    if (pathname === "/mcp") {
      return this.handleMcpRequest(request);
    }

    return new Response(
      JSON.stringify({
        connected: this.ws !== null,
        deviceId: this.deviceId,
        expectedDeviceId: this.expectedDeviceId,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private handleWebSocketUpgrade(_request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    server.addEventListener("message", async (event) => {
      try {
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
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

  private async handleTunnelMessage(
    server: WebSocket,
    msg: TunnelMessage
  ): Promise<void> {
    switch (msg.type) {
      case "auth": {
        if (
          this.expectedDeviceId &&
          msg.device_id !== this.expectedDeviceId
        ) {
          server.send(
            JSON.stringify({
              type: "auth_error",
              reason: `device_id mismatch: expected '${this.expectedDeviceId}'`,
            }) + "\n"
          );
          server.close(1008, "Authentication failed");
          return;
        }

        const device = await authenticateDevice(
          this.env,
          msg.device_id,
          msg.token
        );
        if (!device) {
          server.send(
            JSON.stringify({
              type: "auth_error",
              reason: "Invalid device credentials",
            }) + "\n"
          );
          server.close(1008, "Authentication failed");
          return;
        }
        this.ws = server;
        this.deviceId = msg.device_id;
        this.sessionId = crypto.randomUUID();
        await updateDeviceStatus(this.env, msg.device_id, "online");
        server.send(
          JSON.stringify({ type: "auth_ok", session_id: this.sessionId }) +
            "\n"
        );
        break;
      }
      case "tool_progress": {
        const pending = this.pendingTools.get(msg.id);
        if (pending && typeof msg.chunk === "string") {
          pending.chunks.push(msg.chunk);
        }
        break;
      }
      case "tool_result": {
        this.resolveToolResult(msg.id, {
          type: "tool_result",
          result: msg.result,
        });
        break;
      }
      case "tool_error": {
        this.resolveToolResult(msg.id, {
          type: "tool_error",
          error: msg.error,
        });
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
        break;
    }
  }

  private cleanupWebSocket(): void {
    if (this.deviceId) {
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

  private mergeProgressIntoResult(
    chunks: string[],
    result?: ToolResultMessage["result"]
  ): ToolResultMessage["result"] {
    if (chunks.length === 0) return result;
    const progressText = chunks.join("");
    const existingText =
      result?.content?.map((c) => c.text).join("") ?? "";
    const combined = progressText + existingText;
    return {
      content: [{ type: "text", text: combined }],
      isError: result?.isError,
    };
  }

  private resolveToolResult(
    id: string,
    value: ToolResultPayload | ToolErrorPayload
  ): void {
    const pending = this.pendingTools.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);

    if (value.type === "tool_result" && pending.chunks.length > 0) {
      pending.resolve({
        type: "tool_result",
        result: this.mergeProgressIntoResult(pending.chunks, value.result),
      });
    } else {
      pending.resolve(value);
    }
    this.pendingTools.delete(id);
  }

  private async handleMcpRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return jsonRpcResponse("0", { tools: TOOL_CATALOG });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body: {
      method?: string;
      id?: string | number | null;
      params?: {
        name?: string;
        arguments?: Record<string, unknown>;
        deviceId?: string;
      };
    };
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(
        null,
        "INVALID_ARGUMENTS",
        "Invalid JSON body",
        JsonRpcCode.PARSE_ERROR,
        400
      );
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
      return jsonRpcResponse(id, { tools: TOOL_CATALOG });
    }

    if (method === "tools/call") {
      const toolName = body.params?.name;
      const toolArgs = body.params?.arguments ?? {};

      if (!toolName || !TOOL_NAMES.has(toolName)) {
        return jsonRpcError(
          id,
          "TOOL_NOT_FOUND",
          `Tool '${toolName}' not found`,
          JsonRpcCode.METHOD_NOT_FOUND,
          404
        );
      }

      if (!this.ws || !this.deviceId) {
        return jsonRpcError(
          id,
          "DEVICE_OFFLINE",
          "No daemon connected",
          JsonRpcCode.SERVER_ERROR,
          503
        );
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
          resolve(
            jsonRpcError(
              id,
              "TOOL_TIMEOUT",
              "Tool execution timed out",
              JsonRpcCode.SERVER_ERROR,
              504
            )
          );
        }, TOOL_TIMEOUT_MS);

        this.pendingTools.set(requestId, {
          resolve: (value) => {
            if (value.type === "tool_error") {
              const http =
                value.error.code === "DEVICE_OFFLINE" ? 503 : 500;
              resolve(
                jsonRpcError(
                  id,
                  value.error.code,
                  value.error.message,
                  JsonRpcCode.SERVER_ERROR,
                  http
                )
              );
            } else {
              resolve(jsonRpcResponse(id, value.result));
            }
          },
          reject: () => {
            resolve(
              jsonRpcError(
                id,
                "DEVICE_OFFLINE",
                "Daemon disconnected while executing tool",
                JsonRpcCode.SERVER_ERROR,
                503
              )
            );
          },
          timer,
          chunks: [],
        });

        try {
          this.ws!.send(JSON.stringify(executeMsg) + "\n");
        } catch {
          this.pendingTools.delete(requestId);
          clearTimeout(timer);
          resolve(
            jsonRpcError(
              id,
              "DEVICE_OFFLINE",
              "Failed to send tool request to daemon",
              JsonRpcCode.SERVER_ERROR,
              503
            )
          );
        }
      });
    }

    return jsonRpcError(
      id,
      "METHOD_NOT_FOUND",
      `Method '${method}' not supported`,
      JsonRpcCode.METHOD_NOT_FOUND,
      404
    );
  }
}

function jsonRpcResponse(
  id: string | number | null,
  result: unknown
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(
  id: string | number | null,
  deckCode: string,
  message: string,
  rpcCode: number,
  status = 500
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: rpcCode, message, data: { code: deckCode } },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
