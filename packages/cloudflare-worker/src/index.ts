import type { Env } from "./types.js";
import { verifyApiToken } from "./auth.js";
import {
  getDevice,
  setDevice,
  removeDevice,
  updateDeviceStatus,
  hashToken,
} from "./device-registry.js";

export { TunnelDO } from "./tunnel-do.js";

const startTime = Date.now();

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string
): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function requireApiToken(
  request: Request,
  env: Env
): Promise<Response | true> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return errorResponse(401, "UNAUTHORIZED", "Invalid or missing API token");
  }
  const token = auth.slice("Bearer ".length).trim();
  const ok = await verifyApiToken(token, env);
  if (!ok) {
    return errorResponse(401, "UNAUTHORIZED", "Invalid or missing API token");
  }
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/health") {
        return jsonResponse({
          status: "ok",
          uptime: Date.now() - startTime,
        });
      }

      if (url.pathname === "/tunnel") {
        // WebSocket upgrade — auth happens inside the DO after connection
        const doId = env.TUNNEL_DO.idFromName("default");
        const doStub = env.TUNNEL_DO.get(doId);
        return doStub.fetch(request);
      }

      if (url.pathname === "/mcp") {
        const auth = await requireApiToken(request, env);
        if (auth !== true) return auth;
        const doId = env.TUNNEL_DO.idFromName("default");
        const doStub = env.TUNNEL_DO.get(doId);
        return doStub.fetch(request);
      }

      if (url.pathname.startsWith("/api/devices")) {
        const auth = await requireApiToken(request, env);
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
            return errorResponse(400, "INVALID_ARGUMENTS", "Invalid JSON body");
          }
          if (!body.device_id || !body.token) {
            return errorResponse(
              400,
              "INVALID_ARGUMENTS",
              "Missing device_id or token"
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
          return jsonResponse({ ok: true, device_id: body.device_id });
        }

        const deviceId = url.pathname.slice("/api/devices/".length);
        if (!deviceId) return errorResponse(404, "NOT_FOUND", "Not found");
        if (request.method === "GET") {
          const device = await getDevice(env, deviceId);
          if (!device)
            return errorResponse(404, "DEVICE_NOT_FOUND", "Device not found");
          return jsonResponse(device);
        }
        if (request.method === "DELETE") {
          await removeDevice(env, deviceId);
          return jsonResponse({ ok: true });
        }
        if (request.method === "PATCH") {
          const body = (await request.json()) as { status?: string };
          if (
            !body.status ||
            (body.status !== "online" && body.status !== "offline")
          ) {
            return errorResponse(400, "INVALID_ARGUMENTS", "Invalid status");
          }
          await updateDeviceStatus(
            env,
            deviceId,
            body.status as "online" | "offline"
          );
          return jsonResponse({ ok: true });
        }
        return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }

      return errorResponse(404, "NOT_FOUND", "Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(500, "INTERNAL_ERROR", `Internal error: ${message}`);
    }
  },
};
