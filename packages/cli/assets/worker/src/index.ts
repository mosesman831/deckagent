import type { Env } from "./types.js";
import { verifyApiToken } from "./auth.js";
import {
  getDevice,
  setDevice,
  removeDevice,
  updateDeviceStatus,
  hashToken,
} from "./device-registry.js";
import { handleMcpRequest } from "./mcp-handler.js";

export { TunnelDO } from "./tunnel-do.js";

const startTime = Date.now();

/**
 * CORS for /mcp and API: never use `*` when Authorization is used.
 * Echo request Origin when present; omit ACAO for non-browser clients.
 */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function jsonResponse(
  data: unknown,
  status = 200,
  cors: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  cors: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function requireApiToken(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response | true> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Invalid or missing API token",
      cors
    );
  }
  const token = auth.slice("Bearer ".length).trim();
  const ok = await verifyApiToken(token, env);
  if (!ok) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Invalid or missing API token",
      cors
    );
  }
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/health") {
        return jsonResponse(
          {
            status: "ok",
            uptime: Date.now() - startTime,
          },
          200,
          cors
        );
      }

      if (url.pathname === "/tunnel") {
        // Route each device to its own Durable Object before WebSocket upgrade.
        const deviceId = url.searchParams.get("device_id");
        if (!deviceId) {
          return errorResponse(
            400,
            "INVALID_ARGUMENTS",
            "Missing device_id query parameter. Connect to /tunnel?device_id=<id>",
            cors
          );
        }
        const doId = env.TUNNEL_DO.idFromName(deviceId);
        const doStub = env.TUNNEL_DO.get(doId);
        return doStub.fetch(request);
      }

      if (url.pathname === "/mcp") {
        const auth = await requireApiToken(request, env, cors);
        if (auth !== true) return auth;
        return handleMcpRequest(request, env, cors);
      }

      if (url.pathname.startsWith("/api/devices")) {
        const auth = await requireApiToken(request, env, cors);
        if (auth !== true) return auth;

        if (url.pathname === "/api/devices" && request.method === "POST") {
          let body: {
            device_id?: string;
            name?: string;
            token?: string;
            capabilities?: string[];
          };
          try {
            body = await request.json();
          } catch {
            return errorResponse(
              400,
              "INVALID_ARGUMENTS",
              "Invalid JSON body",
              cors
            );
          }
          if (!body.device_id || !body.token) {
            return errorResponse(
              400,
              "INVALID_ARGUMENTS",
              "Missing device_id or token",
              cors
            );
          }
          await setDevice(env, body.device_id, {
            id: body.device_id,
            name: body.name ?? body.device_id,
            status: "offline",
            token_hash: await hashToken(body.token),
            capabilities: body.capabilities ?? [],
            last_seen: Date.now(),
          });
          return jsonResponse({ ok: true, device_id: body.device_id }, 200, cors);
        }

        const deviceId = url.pathname.slice("/api/devices/".length);
        if (!deviceId) return errorResponse(404, "NOT_FOUND", "Not found", cors);
        if (request.method === "GET") {
          const device = await getDevice(env, deviceId);
          if (!device)
            return errorResponse(
              404,
              "DEVICE_NOT_FOUND",
              "Device not found",
              cors
            );
          return jsonResponse(device, 200, cors);
        }
        if (request.method === "DELETE") {
          await removeDevice(env, deviceId);
          return jsonResponse({ ok: true }, 200, cors);
        }
        if (request.method === "PATCH") {
          const body = (await request.json()) as { status?: string };
          if (
            !body.status ||
            (body.status !== "online" && body.status !== "offline")
          ) {
            return errorResponse(
              400,
              "INVALID_ARGUMENTS",
              "Invalid status",
              cors
            );
          }
          await updateDeviceStatus(
            env,
            deviceId,
            body.status as "online" | "offline"
          );
          return jsonResponse({ ok: true }, 200, cors);
        }
        return errorResponse(
          405,
          "METHOD_NOT_ALLOWED",
          "Method not allowed",
          cors
        );
      }

      return errorResponse(404, "NOT_FOUND", "Not found", cors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        `Internal error: ${message}`,
        cors
      );
    }
  },
};
