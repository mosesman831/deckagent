import type { Env } from "./types.js";
import { z } from "zod";
import { JsonRpcCode } from "./types.js";
import { TOOL_CATALOG } from "./tool-catalog.js";
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
import { listDevices, resolveTargetDeviceId } from "./device-registry.js";
import {
  MIN_PROTOCOL_VERSION,
  WORKER_VERSION,
} from "./protocol.js";

export { TOOL_CATALOG as tools, filterToolCatalog } from "./tool-catalog.js";
export { PROMPT_CATALOG, MCP_INSTRUCTIONS } from "./prompt-catalog.js";
export { RESOURCE_CATALOG } from "./resource-catalog.js";

type JsonRpcId = string | number | null;

const LIST_DEVICES_ARGS_SCHEMA = z.object({}).strict();

function jsonRpcResponse(id: JsonRpcId, result: unknown, cors: HeadersInit): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json", ...cors },
  });
}

/**
 * JSON-RPC error with numeric code; DeckAgent string code in `data.code`.
 */
function jsonRpcError(
  id: JsonRpcId,
  deckCode: string,
  message: string,
  options: {
    rpcCode?: number;
    httpStatus?: number;
    cors?: HeadersInit;
  } = {}
): Response {
  const rpcCode = options.rpcCode ?? JsonRpcCode.SERVER_ERROR;
  const httpStatus = options.httpStatus ?? 500;
  const cors = options.cors ?? {};
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: rpcCode,
        message,
        data: { code: deckCode },
      },
    }),
    { status: httpStatus, headers: { "Content-Type": "application/json", ...cors } }
  );
}

function deckCodeToRpc(deckCode: string): number {
  switch (deckCode) {
    case "METHOD_NOT_FOUND":
    case "TOOL_NOT_FOUND":
    case "NOT_FOUND":
      return JsonRpcCode.METHOD_NOT_FOUND;
    case "INVALID_ARGUMENTS":
    case "DEVICE_AMBIGUOUS":
      return JsonRpcCode.INVALID_PARAMS;
    case "DEVICE_OFFLINE":
    case "TOOL_TIMEOUT":
    case "RESOURCE_TIMEOUT":
      return JsonRpcCode.SERVER_ERROR;
    default:
      return JsonRpcCode.SERVER_ERROR;
  }
}

function deckCodeToHttp(deckCode: string): number {
  switch (deckCode) {
    case "METHOD_NOT_FOUND":
    case "TOOL_NOT_FOUND":
    case "NOT_FOUND":
      return 404;
    case "INVALID_ARGUMENTS":
    case "DEVICE_AMBIGUOUS":
      return 400;
    case "DEVICE_OFFLINE":
      return 503;
    case "TOOL_TIMEOUT":
    case "RESOURCE_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

/**
 * Prefer the connected daemon's filtered catalog (via TunnelDO).
 * When no daemon is online, fall back to the full TOOL_CATALOG.
 */
async function resolveToolsList(
  env: Env,
  cors: Record<string, string>,
  id: JsonRpcId,
  requestedDeviceId?: string,
  headerDeviceId?: string | null
): Promise<Response> {
  const resolved = await resolveTargetDeviceId(
    env,
    requestedDeviceId,
    headerDeviceId
  );
  if ("error" in resolved) {
    if (resolved.error === "DEVICE_OFFLINE") {
      return jsonRpcResponse(id, { tools: TOOL_CATALOG }, cors);
    }
    // Ambiguous multi-device: still return full catalog so clients can connect;
    // tools/call will require deviceId.
    if (resolved.error === "DEVICE_AMBIGUOUS") {
      return jsonRpcResponse(id, { tools: TOOL_CATALOG }, cors);
    }
    return jsonRpcError(id, resolved.error, resolved.message, {
      rpcCode: deckCodeToRpc(resolved.error),
      httpStatus: deckCodeToHttp(resolved.error),
      cors,
    });
  }

  const doId = env.TUNNEL_DO.idFromName(resolved.deviceId);
  const stub = env.TUNNEL_DO.get(doId);
  const forwardBody = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: { deviceId: resolved.deviceId },
  });

  try {
    const doResponse = await stub.fetch(
      new Request("https://tunnel-do/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: forwardBody,
      })
    );
    const headers = new Headers(doResponse.headers);
    for (const [k, v] of Object.entries(cors)) {
      headers.set(k, v);
    }
    return new Response(doResponse.body, {
      status: doResponse.status,
      headers,
    });
  } catch {
    return jsonRpcResponse(id, { tools: TOOL_CATALOG }, cors);
  }
}

/**
 * Handle MCP Streamable HTTP at the Worker edge.
 * initialize is local; tools/list is filtered via TunnelDO when a daemon is online;
 * tools/call is routed to the device's DO.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (request.method === "GET") {
    return resolveToolsList(
      env,
      cors,
      "0",
      undefined,
      request.headers.get("X-DeckAgent-Device-Id")
    );
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: cors,
    });
  }

  let body: {
    jsonrpc?: string;
    method?: string;
    id?: JsonRpcId;
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
    return jsonRpcError(null, "INVALID_ARGUMENTS", "Invalid JSON body", {
      rpcCode: JsonRpcCode.PARSE_ERROR,
      httpStatus: 400,
      cors,
    });
  }

  const method = body.method ?? "";
  const id = body.id ?? null;

  if (method === "initialize") {
    return jsonRpcResponse(
      id,
      {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          prompts: {},
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: env.APP_NAME || "DeckAgent",
          version: WORKER_VERSION,
          metadata: {
            minProtocolVersion: MIN_PROTOCOL_VERSION,
          },
        },
        instructions: MCP_INSTRUCTIONS,
      },
      cors
    );
  }

  if (method === "notifications/initialized") {
    // MCP clients may send this; acknowledge with empty result.
    return jsonRpcResponse(id, {}, cors);
  }

  if (method === "tools/list") {
    return resolveToolsList(
      env,
      cors,
      id,
      body.params?.deviceId,
      request.headers.get("X-DeckAgent-Device-Id")
    );
  }

  if (method === "prompts/list") {
    return jsonRpcResponse(id, { prompts: PROMPT_CATALOG }, cors);
  }

  if (method === "prompts/get") {
    const promptName = body.params?.name;
    const promptArgs =
      (body.params?.arguments as Record<string, unknown> | undefined) ?? {};
    if (!promptName || !isKnownPrompt(promptName)) {
      return jsonRpcError(
        id,
        "METHOD_NOT_FOUND",
        `Prompt '${promptName ?? ""}' not found`,
        {
          rpcCode: JsonRpcCode.INVALID_PARAMS,
          httpStatus: 404,
          cors,
        }
      );
    }
    const prompt = getPromptMessages(promptName, promptArgs);
    if (!prompt) {
      return jsonRpcError(id, "METHOD_NOT_FOUND", `Prompt '${promptName}' not found`, {
        rpcCode: JsonRpcCode.INVALID_PARAMS,
        httpStatus: 404,
        cors,
      });
    }
    return jsonRpcResponse(id, prompt, cors);
  }

  if (method === "resources/list") {
    return jsonRpcResponse(id, { resources: RESOURCE_CATALOG }, cors);
  }

  if (method === "resources/read") {
    const uri = body.params?.uri;
    if (!uri || typeof uri !== "string") {
      return jsonRpcError(id, "INVALID_ARGUMENTS", "Missing params.uri", {
        rpcCode: JsonRpcCode.INVALID_PARAMS,
        httpStatus: 400,
        cors,
      });
    }

    if (!isKnownResourceUri(uri)) {
      return jsonRpcError(id, "NOT_FOUND", `Resource '${uri}' not found`, {
        rpcCode: JsonRpcCode.METHOD_NOT_FOUND,
        httpStatus: 404,
        cors,
      });
    }

    if (isStaticResourceUri(uri)) {
      const content = await readStaticResource(uri, env);
      if (!content) {
        return jsonRpcError(id, "NOT_FOUND", `Resource '${uri}' not found`, {
          rpcCode: JsonRpcCode.METHOD_NOT_FOUND,
          httpStatus: 404,
          cors,
        });
      }
      return jsonRpcResponse(id, { contents: [content] }, cors);
    }

    if (isDaemonResourceUri(uri)) {
      const requestedDeviceId = body.params?.deviceId;
      const resolved = await resolveTargetDeviceId(
        env,
        requestedDeviceId,
        request.headers.get("X-DeckAgent-Device-Id")
      );
      if ("error" in resolved) {
        return jsonRpcError(id, resolved.error, resolved.message, {
          rpcCode: deckCodeToRpc(resolved.error),
          httpStatus: deckCodeToHttp(resolved.error),
          cors,
        });
      }

      const doId = env.TUNNEL_DO.idFromName(resolved.deviceId);
      const stub = env.TUNNEL_DO.get(doId);
      const forwardBody = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "resources/read",
        params: {
          uri,
          deviceId: resolved.deviceId,
          arguments: body.params?.arguments ?? {},
        },
      });

      const doResponse = await stub.fetch(
        new Request("https://tunnel-do/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: forwardBody,
        })
      );

      const headers = new Headers(doResponse.headers);
      for (const [k, v] of Object.entries(cors)) {
        headers.set(k, v);
      }
      return new Response(doResponse.body, {
        status: doResponse.status,
        headers,
      });
    }

    return jsonRpcError(id, "NOT_FOUND", `Resource '${uri}' not found`, {
      rpcCode: JsonRpcCode.METHOD_NOT_FOUND,
      httpStatus: 404,
      cors,
    });
  }

  if (method === "tools/call") {
    const toolName = body.params?.name;
    const toolArgs = body.params?.arguments ?? {};
    const requestedDeviceId = body.params?.deviceId;

    if (!toolName) {
      return jsonRpcError(
        id,
        "TOOL_NOT_FOUND",
        `Tool '${toolName ?? ""}' not found`,
        {
          rpcCode: JsonRpcCode.METHOD_NOT_FOUND,
          httpStatus: 404,
          cors,
        }
      );
    }

    if (toolName === "list_devices") {
      const parsed = LIST_DEVICES_ARGS_SCHEMA.safeParse(toolArgs);
      if (!parsed.success) {
        return jsonRpcError(
          id,
          "INVALID_ARGUMENTS",
          "list_devices accepts an empty arguments object",
          {
            rpcCode: JsonRpcCode.INVALID_PARAMS,
            httpStatus: 400,
            cors,
          }
        );
      }
      return jsonRpcResponse(id, { devices: await listDevices(env) }, cors);
    }

    const resolved = await resolveTargetDeviceId(
      env,
      requestedDeviceId,
      request.headers.get("X-DeckAgent-Device-Id")
    );
    if ("error" in resolved) {
      return jsonRpcError(id, resolved.error, resolved.message, {
        rpcCode: deckCodeToRpc(resolved.error),
        httpStatus: deckCodeToHttp(resolved.error),
        cors,
      });
    }

    const doId = env.TUNNEL_DO.idFromName(resolved.deviceId);
    const stub = env.TUNNEL_DO.get(doId);

    // Forward tools/call to the device's Durable Object for execution.
    const forwardBody = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArgs,
        deviceId: resolved.deviceId,
      },
    });

    // Forward Accept so the DO can choose SSE vs JSON for execute_command_stream.
    const accept = request.headers.get("Accept") ?? "application/json";
    const doResponse = await stub.fetch(
      new Request("https://tunnel-do/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: accept,
        },
        body: forwardBody,
      })
    );

    // Ensure CORS headers on the proxied response (preserve Content-Type for SSE).
    const headers = new Headers(doResponse.headers);
    for (const [k, v] of Object.entries(cors)) {
      headers.set(k, v);
    }
    return new Response(doResponse.body, {
      status: doResponse.status,
      headers,
    });
  }

  return jsonRpcError(
    id,
    "METHOD_NOT_FOUND",
    `Method '${method}' not supported`,
    {
      rpcCode: JsonRpcCode.METHOD_NOT_FOUND,
      httpStatus: 404,
      cors,
    }
  );
}
