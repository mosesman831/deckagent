import type { Env } from "./types.js";
import { JsonRpcCode } from "./types.js";
import { TOOL_CATALOG, TOOL_NAMES } from "./tool-catalog.js";
import {
  MCP_INSTRUCTIONS,
  PROMPT_CATALOG,
  getPromptMessages,
  isKnownPrompt,
} from "./prompt-catalog.js";
import { resolveTargetDeviceId } from "./device-registry.js";

export { TOOL_CATALOG as tools } from "./tool-catalog.js";
export { PROMPT_CATALOG, MCP_INSTRUCTIONS } from "./prompt-catalog.js";

type JsonRpcId = string | number | null;

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
      return JsonRpcCode.METHOD_NOT_FOUND;
    case "INVALID_ARGUMENTS":
    case "DEVICE_AMBIGUOUS":
      return JsonRpcCode.INVALID_PARAMS;
    case "DEVICE_OFFLINE":
    case "TOOL_TIMEOUT":
      return JsonRpcCode.SERVER_ERROR;
    default:
      return JsonRpcCode.SERVER_ERROR;
  }
}

function deckCodeToHttp(deckCode: string): number {
  switch (deckCode) {
    case "METHOD_NOT_FOUND":
    case "TOOL_NOT_FOUND":
      return 404;
    case "INVALID_ARGUMENTS":
    case "DEVICE_AMBIGUOUS":
      return 400;
    case "DEVICE_OFFLINE":
      return 503;
    case "TOOL_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

/**
 * Handle MCP Streamable HTTP at the Worker edge.
 * initialize / tools/list are local; tools/call is routed to the device's DO.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (request.method === "GET") {
    return jsonRpcResponse("0", { tools: TOOL_CATALOG }, cors);
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
          resources: {},
        },
        serverInfo: { name: env.APP_NAME || "DeckAgent", version: "0.1.0" },
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
    return jsonRpcResponse(id, { tools: TOOL_CATALOG }, cors);
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
    // No static resources yet — return empty list so playgrounds don't 404.
    return jsonRpcResponse(id, { resources: [] }, cors);
  }

  if (method === "tools/call") {
    const toolName = body.params?.name;
    const toolArgs = body.params?.arguments ?? {};
    const requestedDeviceId = body.params?.deviceId;

    if (!toolName || !TOOL_NAMES.has(toolName)) {
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

    const resolved = await resolveTargetDeviceId(env, requestedDeviceId);
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

    const doResponse = await stub.fetch(
      new Request("https://tunnel-do/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: forwardBody,
      })
    );

    // Ensure CORS headers on the proxied response.
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
