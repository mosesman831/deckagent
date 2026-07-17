import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Logger } from "./logger.js";
import type { ToolExecutor } from "./tool-executor.js";
import { readLocalResource } from "./resources.js";

export const LOCAL_WS_HOST = "127.0.0.1";
export const LOCAL_WS_PORT = 9147;

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

/**
 * Localhost WebSocket server for the v2 browser extension.
 * Binds only to 127.0.0.1 — no remote access.
 * Protocol: JSON-line-delimited messages, path `/tunnel`.
 * Tool execution goes through the same policy + ToolExecutor as the Worker tunnel.
 */
export class LocalTunnelServer {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private logger: Logger;
  private executor: ToolExecutor;
  private host: string;
  private port: number;
  private clients = new Set<WebSocket>();

  constructor(
    executor: ToolExecutor,
    logger: Logger,
    options?: { host?: string; port?: number },
  ) {
    this.executor = executor;
    this.logger = logger;
    this.host = options?.host ?? LOCAL_WS_HOST;
    this.port = options?.port ?? LOCAL_WS_PORT;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;

    await new Promise<void>((resolve, reject) => {
      const httpServer = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("DeckAgent local tunnel\n");
      });

      const wss = new WebSocketServer({
        server: httpServer,
        path: "/tunnel",
      });

      wss.on("connection", (ws, req) => {
        const remote = req.socket.remoteAddress || "";
        if (!isLoopback(remote)) {
          this.logger.warn(
            `Rejected non-localhost local tunnel connection from ${remote}`,
          );
          ws.close(1008, "localhost_only");
          return;
        }

        this.logger.info("Local extension WebSocket connected");
        this.clients.add(ws);

        let buffered = "";

        ws.on("message", (data) => {
          buffered += data.toString("utf-8");
          let newlineIndex: number;
          while ((newlineIndex = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, newlineIndex);
            buffered = buffered.slice(newlineIndex + 1);
            if (line.trim().length === 0) continue;
            void this.onMessageLine(ws, line);
          }
        });

        ws.on("close", () => {
          this.clients.delete(ws);
          this.logger.info("Local extension WebSocket disconnected");
        });

        ws.on("error", (err) => {
          this.logger.warn(
            `Local WebSocket error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        // Optional hello so extension knows daemon is ready.
        this.send(ws, {
          type: "local_ready",
          version: 1,
        });
      });

      httpServer.on("error", (err) => {
        this.logger.error(
          `Local tunnel server error: ${err instanceof Error ? err.message : String(err)}`,
        );
        reject(err);
      });

      httpServer.listen(this.port, this.host, () => {
        this.httpServer = httpServer;
        this.wss = wss;
        this.logger.info(
          `Local tunnel WebSocket listening on ws://${this.host}:${this.port}/tunnel`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) {
      try {
        ws.close(1000, "daemon_shutdown");
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    const wss = this.wss;
    this.wss = null;
    if (wss) {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }

    const httpServer = this.httpServer;
    this.httpServer = null;
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  }

  private async onMessageLine(ws: WebSocket, line: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.logger.warn("Local tunnel received invalid JSON line");
      return;
    }

    // Support both Worker-style execute_tool and JSON-RPC wrappers from extension.
    const execute = coerceExecuteTool(msg);
    if (execute) {
      await this.handleExecuteTool(ws, execute);
      return;
    }

    const resource = coerceReadResource(msg);
    if (resource) {
      this.handleReadResource(ws, resource);
      return;
    }

    if (msg.type === "ping" || msg.method === "ping") {
      this.send(ws, { type: "pong", timestamp: Date.now() });
      return;
    }

    // Acknowledge intercepted adapter messages without failing the socket.
    if (
      typeof msg.method === "string" &&
      msg.method === "intercepted_adapter_message"
    ) {
      this.logger.debug("Received intercepted_adapter_message from extension");
      if (msg.id !== undefined) {
        this.send(ws, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { ok: true },
        });
      }
      return;
    }

    this.logger.debug(
      `Local tunnel ignored message type=${String(msg.type)} method=${String(msg.method)}`,
    );
  }

  private async handleExecuteTool(
    ws: WebSocket,
    msg: ExecuteToolMessage,
  ): Promise<void> {
    const outcome = await this.executor.execute(msg.id, msg.tool, msg.args, {
      source: "local",
      onProgress: (chunk) => {
        this.send(ws, {
          type: "tool_progress",
          id: msg.id,
          chunk,
        });
      },
    });

    if (outcome.ok) {
      this.send(ws, {
        type: "tool_result",
        id: msg.id,
        result: {
          content: outcome.result.content,
          isError: outcome.result.isError,
        },
      });
      return;
    }

    this.send(ws, {
      type: "tool_error",
      id: msg.id,
      error: {
        code: outcome.code,
        message: outcome.message,
      },
    });
  }

  private handleReadResource(ws: WebSocket, msg: ReadResourceMessage): void {
    const result = readLocalResource(msg.uri, msg.args, {
      policy: this.executor.getPolicy(),
      workspace: this.executor.getWorkspace(),
      auditLogDir: this.executor.getAuditLogDir(),
    });

    if (result.ok) {
      this.send(ws, {
        type: "resource_result",
        id: msg.id,
        contents: result.contents,
      });
      return;
    }

    this.send(ws, {
      type: "resource_error",
      id: msg.id,
      error: {
        code: result.code,
        message: result.message,
      },
    });
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const line = JSON.stringify(message) + "\n";
    ws.send(line, (err) => {
      if (err) {
        this.logger.error(
          `Local WebSocket send error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}

function isLoopback(address: string): boolean {
  if (!address) return false;
  if (address === "127.0.0.1" || address === "::1") return true;
  if (address === "::ffff:127.0.0.1") return true;
  return false;
}

function coerceExecuteTool(
  msg: Record<string, unknown>,
): ExecuteToolMessage | null {
  if (
    msg.type === "execute_tool" &&
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

  // JSON-RPC style: { method: "execute_tool", params: { tool, args }, id }
  if (
    msg.method === "execute_tool" &&
    msg.params !== null &&
    typeof msg.params === "object"
  ) {
    const params = msg.params as Record<string, unknown>;
    const tool =
      typeof params.tool === "string"
        ? params.tool
        : typeof params.name === "string"
          ? params.name
          : null;
    const args =
      params.args !== null && typeof params.args === "object"
        ? (params.args as Record<string, unknown>)
        : params.arguments !== null && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : null;
    if (tool && args) {
      const id =
        typeof msg.id === "string" || typeof msg.id === "number"
          ? String(msg.id)
          : `local-${Date.now()}`;
      return { type: "execute_tool", id, tool, args };
    }
  }

  return null;
}

function coerceReadResource(
  msg: Record<string, unknown>,
): ReadResourceMessage | null {
  if (
    msg.type === "read_resource" &&
    typeof msg.id === "string" &&
    typeof msg.uri === "string"
  ) {
    const args =
      msg.args !== null && typeof msg.args === "object"
        ? (msg.args as Record<string, unknown>)
        : undefined;
    return { type: "read_resource", id: msg.id, uri: msg.uri, args };
  }

  // JSON-RPC style: { method: "read_resource", params: { uri, args? }, id }
  if (
    msg.method === "read_resource" &&
    msg.params !== null &&
    typeof msg.params === "object"
  ) {
    const params = msg.params as Record<string, unknown>;
    if (typeof params.uri !== "string") return null;
    const args =
      params.args !== null && typeof params.args === "object"
        ? (params.args as Record<string, unknown>)
        : undefined;
    const id =
      typeof msg.id === "string" || typeof msg.id === "number"
        ? String(msg.id)
        : `local-res-${Date.now()}`;
    return { type: "read_resource", id, uri: params.uri, args };
  }

  return null;
}
