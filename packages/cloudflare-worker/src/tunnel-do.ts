import type {
  Env,
  TunnelMessage,
  ExecuteToolMessage,
  ToolResultMessage,
  AuthOkMessage,
  ReadResourceMessage,
  ResourceResultMessage,
  PolicyCapsMessage,
} from "./types.js";
import { JsonRpcCode } from "./types.js";
import {
  TOOL_NAMES,
  filterToolCatalog,
  type McpToolDefinition,
} from "./tool-catalog.js";
import {
  MCP_INSTRUCTIONS,
  PROMPT_CATALOG,
  getPromptMessages,
  isKnownPrompt,
} from "./prompt-catalog.js";
import {
  RESOURCE_CATALOG,
  isDaemonResourceUri,
  isKnownResourceUri,
  isStaticResourceUri,
  readStaticResource,
} from "./resource-catalog.js";
import { appendErrorHint, getErrorHint } from "./error-hints.js";
import { authenticateDevice, updateDeviceStatus } from "./device-registry.js";
import {
  MIN_PROTOCOL_VERSION,
  WORKER_VERSION,
  checkProtocolVersion,
} from "./protocol.js";
import { isSoftToolErrorCode } from "./errors.js";

// Allow time for local confirmation UX (~90s) plus tool execution headroom.
const TOOL_TIMEOUT_MS = 180_000;
const RESOURCE_TIMEOUT_MS = 30_000;

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
  /**
   * When set (SSE Accept path), progress/result/error are written as SSE
   * events instead of buffering into a final JSON-RPC response.
   */
  sseEnqueue?: (bytes: Uint8Array) => void;
  sseClose?: () => void;
}

const SSE_ENCODER = new TextEncoder();

/** Format a single Server-Sent Event (exported for unit tests). */
export function formatSseEvent(event: string, data: unknown): string {
  const payload =
    typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

function wantsCommandStreamSse(
  request: Request,
  toolName: string
): boolean {
  if (toolName !== "execute_command_stream") return false;
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("text/event-stream");
}

function isDynamicToolDefinition(value: unknown): value is McpToolDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    candidate.inputSchema !== null &&
    typeof candidate.inputSchema === "object" &&
    !Array.isArray(candidate.inputSchema)
  );
}

type ResourceResultPayload = {
  type: "resource_result";
  contents: ResourceResultMessage["contents"];
};

type ResourceErrorPayload = {
  type: "resource_error";
  error: { code: string; message: string };
};

interface PendingResource {
  resolve: (value: ResourceResultPayload | ResourceErrorPayload) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TunnelDO implements DurableObject {
  private ws: WebSocket | null = null;
  private deviceId: string | null = null;
  private expectedDeviceId: string | null = null;
  private sessionId: string | null = null;
  private pendingTools = new Map<string, PendingTool>();
  private pendingResources = new Map<string, PendingResource>();
  private env: Env;
  /**
   * Daemon-reported enabled tool names (S2).
   * `null` = no policy_caps yet → advertise full TOOL_CATALOG.
   */
  private enabledTools: Set<string> | null = null;
  private dynamicTools = new Map<string, McpToolDefinition>();

  constructor(_ctx: DurableObjectState, env: Env) {
    this.env = env;
  }

  /** Exposed for unit tests — apply a policy_caps payload. */
  applyPolicyCapsForTest(
    msg: Pick<PolicyCapsMessage, "tools" | "tool_catalog">
  ): void {
    this.applyPolicyCaps(msg);
  }

  /** Exposed for unit tests — current filter state. */
  getEnabledToolsForTest(): Set<string> | null {
    return this.enabledTools;
  }

  private applyPolicyCaps(
    msg: Pick<PolicyCapsMessage, "tools" | "tool_catalog">
  ): void {
    if (!Array.isArray(msg.tools)) return;
    this.enabledTools = new Set(
      msg.tools.filter((t): t is string => typeof t === "string")
    );
    this.dynamicTools.clear();
    if (!Array.isArray(msg.tool_catalog)) return;
    for (const tool of msg.tool_catalog) {
      if (!isDynamicToolDefinition(tool)) continue;
      if (!this.enabledTools.has(tool.name)) continue;
      if (TOOL_NAMES.has(tool.name)) continue;
      this.dynamicTools.set(tool.name, tool);
    }
  }

  private listedTools(): McpToolDefinition[] {
    const builtinTools = filterToolCatalog(this.enabledTools);
    if (this.enabledTools == null || this.dynamicTools.size === 0) {
      return builtinTools;
    }
    return [...builtinTools, ...this.dynamicTools.values()];
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

        const protocolCheck = checkProtocolVersion(msg.protocol_version);
        if (!protocolCheck.ok) {
          server.send(
            JSON.stringify({
              type: "auth_error",
              reason: protocolCheck.reason,
            }) + "\n"
          );
          server.close(1008, "Protocol mismatch");
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

        const authOk: AuthOkMessage = {
          type: "auth_ok",
          session_id: this.sessionId,
          worker_version: WORKER_VERSION,
          min_protocol_version: MIN_PROTOCOL_VERSION,
          server_time: Date.now(),
        };
        if (protocolCheck.warning) {
          authOk.warning = protocolCheck.warning;
        }

        server.send(JSON.stringify(authOk) + "\n");
        break;
      }
      case "tool_progress": {
        const pending = this.pendingTools.get(msg.id);
        if (pending && typeof msg.chunk === "string") {
          if (pending.sseEnqueue) {
            pending.sseEnqueue(
              SSE_ENCODER.encode(
                formatSseEvent("progress", { chunk: msg.chunk })
              )
            );
          } else {
            pending.chunks.push(msg.chunk);
          }
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
      case "resource_result": {
        this.resolveResourceResult(msg.id, {
          type: "resource_result",
          contents: msg.contents,
        });
        break;
      }
      case "resource_error": {
        this.resolveResourceResult(msg.id, {
          type: "resource_error",
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
      case "policy_caps": {
        this.applyPolicyCaps(msg);
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
    for (const pending of this.pendingResources.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket disconnected"));
    }
    this.pendingResources.clear();
    this.ws = null;
    this.deviceId = null;
    this.sessionId = null;
    this.enabledTools = null;
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

    // SSE streaming path: write final event and close the stream.
    if (pending.sseEnqueue && pending.sseClose) {
      if (value.type === "tool_result") {
        pending.sseEnqueue(
          SSE_ENCODER.encode(formatSseEvent("result", value.result ?? {}))
        );
      } else {
        pending.sseEnqueue(
          SSE_ENCODER.encode(formatSseEvent("error", value.error))
        );
      }
      pending.sseClose();
      this.pendingTools.delete(id);
      return;
    }

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

  private resolveResourceResult(
    id: string,
    value: ResourceResultPayload | ResourceErrorPayload
  ): void {
    const pending = this.pendingResources.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(value);
    this.pendingResources.delete(id);
  }

  private async handleResourcesRead(
    id: string | number | null,
    params?: {
      uri?: string;
      arguments?: Record<string, unknown>;
      deviceId?: string;
    }
  ): Promise<Response> {
    const uri = params?.uri;
    if (!uri || typeof uri !== "string") {
      return jsonRpcError(
        id,
        "INVALID_ARGUMENTS",
        "Missing params.uri",
        JsonRpcCode.INVALID_PARAMS,
        400
      );
    }

    if (!isKnownResourceUri(uri)) {
      return jsonRpcError(
        id,
        "NOT_FOUND",
        `Resource '${uri}' not found`,
        JsonRpcCode.METHOD_NOT_FOUND,
        404
      );
    }

    if (isStaticResourceUri(uri)) {
      const content = await readStaticResource(uri, this.env);
      if (!content) {
        return jsonRpcError(
          id,
          "NOT_FOUND",
          `Resource '${uri}' not found`,
          JsonRpcCode.METHOD_NOT_FOUND,
          404
        );
      }
      return jsonRpcResponse(id, { contents: [content] });
    }

    if (!isDaemonResourceUri(uri)) {
      return jsonRpcError(
        id,
        "NOT_FOUND",
        `Resource '${uri}' not found`,
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
    const readMsg: ReadResourceMessage = {
      type: "read_resource",
      id: requestId,
      uri,
      args: params?.arguments ?? {},
    };

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResources.delete(requestId);
        resolve(
          jsonRpcError(
            id,
            "RESOURCE_TIMEOUT",
            "Resource read timed out",
            JsonRpcCode.SERVER_ERROR,
            504
          )
        );
      }, RESOURCE_TIMEOUT_MS);

      this.pendingResources.set(requestId, {
        resolve: (value) => {
          if (value.type === "resource_error") {
            const code = value.error.code || "INTERNAL_ERROR";
            const http =
              code === "NOT_FOUND"
                ? 404
                : code === "DEVICE_OFFLINE"
                  ? 503
                  : 500;
            const rpc =
              code === "NOT_FOUND"
                ? JsonRpcCode.METHOD_NOT_FOUND
                : JsonRpcCode.SERVER_ERROR;
            resolve(
              jsonRpcError(id, code, value.error.message, rpc, http)
            );
            return;
          }
          resolve(jsonRpcResponse(id, { contents: value.contents }));
        },
        reject: () => {
          resolve(
            jsonRpcError(
              id,
              "DEVICE_OFFLINE",
              "Daemon disconnected while reading resource",
              JsonRpcCode.SERVER_ERROR,
              503
            )
          );
        },
        timer,
      });

      try {
        this.ws!.send(JSON.stringify(readMsg) + "\n");
      } catch {
        this.pendingResources.delete(requestId);
        clearTimeout(timer);
        resolve(
          jsonRpcError(
            id,
            "DEVICE_OFFLINE",
            "Failed to send resource request to daemon",
            JsonRpcCode.SERVER_ERROR,
            503
          )
        );
      }
    });
  }

  private async handleMcpRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return jsonRpcResponse("0", { tools: this.listedTools() });
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
        uri?: string;
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
        capabilities: {
          tools: {},
          prompts: {},
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: "DeckAgent",
          version: WORKER_VERSION,
          metadata: {
            minProtocolVersion: MIN_PROTOCOL_VERSION,
          },
        },
        instructions: MCP_INSTRUCTIONS,
      });
    }

    if (method === "tools/list") {
      return jsonRpcResponse(id, { tools: this.listedTools() });
    }

    if (method === "prompts/list") {
      return jsonRpcResponse(id, { prompts: PROMPT_CATALOG });
    }

    if (method === "prompts/get") {
      const promptName = body.params?.name;
      const promptArgs = body.params?.arguments ?? {};
      if (!promptName || !isKnownPrompt(promptName)) {
        return jsonRpcError(
          id,
          "METHOD_NOT_FOUND",
          `Prompt '${promptName ?? ""}' not found`,
          JsonRpcCode.INVALID_PARAMS,
          404
        );
      }
      const prompt = getPromptMessages(promptName, promptArgs);
      if (!prompt) {
        return jsonRpcError(
          id,
          "METHOD_NOT_FOUND",
          `Prompt '${promptName}' not found`,
          JsonRpcCode.INVALID_PARAMS,
          404
        );
      }
      return jsonRpcResponse(id, prompt);
    }

    if (method === "resources/list") {
      return jsonRpcResponse(id, { resources: RESOURCE_CATALOG });
    }

    if (method === "resources/read") {
      return this.handleResourcesRead(id, body.params);
    }

    if (method === "tools/call") {
      const toolName = body.params?.name;
      const toolArgs = body.params?.arguments ?? {};

      if (
        !toolName ||
        (!TOOL_NAMES.has(toolName) && !this.dynamicTools.has(toolName))
      ) {
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

      // F7: SSE streaming for execute_command_stream when client Accepts event-stream.
      if (wantsCommandStreamSse(request, toolName)) {
        const { readable, writable } = new TransformStream<Uint8Array>();
        const writer = writable.getWriter();

        const writeSse = (bytes: Uint8Array): void => {
          writer.write(bytes).catch(() => {});
        };
        const closeSse = (): void => {
          writer.close().catch(() => {});
        };

        const timer = setTimeout(() => {
          this.pendingTools.delete(requestId);
          writeSse(
            SSE_ENCODER.encode(
              formatSseEvent("error", {
                code: "TOOL_TIMEOUT",
                message: "Tool execution timed out",
              })
            )
          );
          closeSse();
        }, TOOL_TIMEOUT_MS);

        this.pendingTools.set(requestId, {
          resolve: () => {
            /* unused — SSE uses sseEnqueue/sseClose via resolveToolResult */
          },
          reject: () => {
            writeSse(
              SSE_ENCODER.encode(
                formatSseEvent("error", {
                  code: "DEVICE_OFFLINE",
                  message: "Daemon disconnected while executing tool",
                })
              )
            );
            closeSse();
          },
          timer,
          chunks: [],
          sseEnqueue: writeSse,
          sseClose: closeSse,
        });

        try {
          this.ws!.send(JSON.stringify(executeMsg) + "\n");
        } catch {
          this.pendingTools.delete(requestId);
          clearTimeout(timer);
          writeSse(
            SSE_ENCODER.encode(
              formatSseEvent("error", {
                code: "DEVICE_OFFLINE",
                message: "Failed to send tool request to daemon",
              })
            )
          );
          closeSse();
        }

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      }

      // Default JSON-RPC path (buffer progress into final result).
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
              // Policy / confirmation / validation failures should be normal
              // MCP tool results (isError) so playgrounds and LLMs can read them.
              if (isSoftToolErrorCode(value.error.code)) {
                resolve(
                  jsonRpcResponse(id, {
                    content: [
                      {
                        type: "text",
                        text: `[${value.error.code}] ${value.error.message}`,
                      },
                    ],
                    isError: true,
                  })
                );
                return;
              }
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
  const hint = getErrorHint(deckCode);
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: rpcCode,
        message: appendErrorHint(message, deckCode),
        data: { code: deckCode, ...(hint ? { hint } : {}) },
      },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
