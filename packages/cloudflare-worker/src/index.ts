import type { Env } from "./types.js";
import { z } from "zod";
import { verifyApiToken } from "./auth.js";
import {
  getDevice,
  setDevice,
  removeDevice,
  updateDeviceStatus,
  hashToken,
  clearPreferredDeviceId,
  getPreferredDeviceId,
  listDevices,
  setPreferredDeviceId,
} from "./device-registry.js";
import { handleMcpRequest } from "./mcp-handler.js";
import {
  DEFAULT_DEVICE_API_RATE_LIMIT_PER_MINUTE,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
} from "./rate-limit.js";

export { TunnelDO } from "./tunnel-do.js";

const startTime = Date.now();

interface WorkerMetrics {
  requests_total: number;
  requests_by_route: Record<string, number>;
  last_updated: string;
}

const workerMetrics: WorkerMetrics = {
  requests_total: 0,
  requests_by_route: {},
  last_updated: new Date(startTime).toISOString(),
};

const DeviceRegisterSchema = z
  .object({
    device_id: z.string().uuid(),
    token: z.string().min(32),
    name: z.string().trim().min(1).max(128).optional(),
    capabilities: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  })
  .strict();

const DevicePreferSchema = z
  .object({
    device_id: z.string().uuid(),
  })
  .strict();

type RateLimitScope = "mcp" | "devices";

const rateLimitWindows = new Map<string, number[]>();

/**
 * CORS for /mcp and API: never use `*` when Authorization is used.
 * Echo request Origin when present; omit ACAO for non-browser clients.
 */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-DeckAgent-Device-Id",
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

function recordWorkerRequest(pathname: string): void {
  const route = routeForMetrics(pathname);
  workerMetrics.requests_total += 1;
  workerMetrics.requests_by_route[route] =
    (workerMetrics.requests_by_route[route] ?? 0) + 1;
  workerMetrics.last_updated = new Date().toISOString();
}

function routeForMetrics(pathname: string): string {
  if (pathname === "/mcp") return "/mcp";
  if (pathname.startsWith("/api/devices")) return "/api/devices";
  if (pathname === "/tunnel") return "/tunnel";
  if (pathname === "/metrics") return "/metrics";
  if (pathname === "/health") return "/health";
  return "other";
}

function getWorkerMetricsSnapshot(): Record<string, unknown> {
  return {
    ...workerMetrics,
    started_at: new Date(startTime).toISOString(),
    uptime_ms: Date.now() - startTime,
    ephemeral: true,
    note:
      "Worker metrics are in-memory per isolate and reset when the isolate restarts.",
  };
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

function rateLimitedResponse(message: string, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ code: "RATE_LIMITED", message }), {
    status: 429,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function formatZodError(prefix: string, error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "body";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
  return `${prefix}: ${details}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rateLimitForScope(env: Env, scope: RateLimitScope): number {
  if (scope === "mcp") {
    return parsePositiveInteger(
      env.RATE_LIMIT_MCP_RPM,
      DEFAULT_MCP_RATE_LIMIT_PER_MINUTE
    );
  }
  return parsePositiveInteger(
    env.RATE_LIMIT_DEVICE_RPM,
    DEFAULT_DEVICE_API_RATE_LIMIT_PER_MINUTE
  );
}

function checkRateLimit(
  tokenHash: string,
  scope: RateLimitScope,
  limit: number,
  now = Date.now()
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const key = `${scope}:${tokenHash}`;
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitWindows.get(key) ?? []).filter(
    (timestamp) => timestamp > windowStart
  );

  if (timestamps.length >= limit) {
    const oldest = timestamps[0] ?? now;
    const retryAfterMs = Math.max(1, RATE_LIMIT_WINDOW_MS - (now - oldest));
    rateLimitWindows.set(key, timestamps);
    return { ok: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  timestamps.push(now);
  rateLimitWindows.set(key, timestamps);
  return { ok: true };
}

function enforceRateLimit(
  tokenHash: string,
  scope: RateLimitScope,
  env: Env,
  cors: Record<string, string>
): Response | null {
  const limit = rateLimitForScope(env, scope);
  const result = checkRateLimit(tokenHash, scope, limit);
  if (result.ok) return null;
  const route = scope === "mcp" ? "/mcp" : "/api/devices";
  return rateLimitedResponse(
    `Rate limit exceeded for ${route}: ${limit} requests per minute. Try again in ${result.retryAfterSeconds} seconds.`,
    cors
  );
}

async function requireApiToken(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response | { tokenHash: string }> {
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
  return { tokenHash: await hashToken(token) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    recordWorkerRequest(url.pathname);

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

      if (url.pathname === "/metrics") {
        const auth = await requireApiToken(request, env, cors);
        if (auth instanceof Response) return auth;
        if (request.method !== "GET") {
          return errorResponse(
            405,
            "METHOD_NOT_ALLOWED",
            "Method not allowed",
            cors
          );
        }
        return jsonResponse(getWorkerMetricsSnapshot(), 200, cors);
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
        if (auth instanceof Response) return auth;
        const limited = enforceRateLimit(auth.tokenHash, "mcp", env, cors);
        if (limited) return limited;
        return handleMcpRequest(request, env, cors);
      }

      if (url.pathname.startsWith("/api/devices")) {
        const auth = await requireApiToken(request, env, cors);
        if (auth instanceof Response) return auth;
        const limited = enforceRateLimit(auth.tokenHash, "devices", env, cors);
        if (limited) return limited;

        if (url.pathname === "/api/devices" && request.method === "GET") {
          return jsonResponse(
            {
              preferred_device_id: await getPreferredDeviceId(env),
              devices: await listDevices(env),
            },
            200,
            cors
          );
        }

        if (url.pathname === "/api/devices" && request.method === "POST") {
          let rawBody: unknown;
          try {
            rawBody = await request.json();
          } catch {
            return errorResponse(
              400,
              "INVALID_ARGUMENTS",
              "Invalid JSON body",
              cors
            );
          }
          const parsed = DeviceRegisterSchema.safeParse(rawBody);
          if (!parsed.success) {
            return errorResponse(
              400,
              "INVALID_ARGUMENTS",
              formatZodError("Invalid device registration", parsed.error),
              cors
            );
          }
          const body = parsed.data;
          await setDevice(env, body.device_id, {
            id: body.device_id,
            name: body.name ?? body.device_id,
            status: "offline",
            token_hash: await hashToken(body.token),
            capabilities: body.capabilities,
            last_seen: Date.now(),
          });
          return jsonResponse({ ok: true, device_id: body.device_id }, 200, cors);
        }

        if (url.pathname === "/api/devices/prefer") {
          if (request.method === "PUT") {
            let rawBody: unknown;
            try {
              rawBody = await request.json();
            } catch {
              return errorResponse(
                400,
                "INVALID_ARGUMENTS",
                "Invalid JSON body",
                cors
              );
            }

            const parsed = DevicePreferSchema.safeParse(rawBody);
            if (!parsed.success) {
              return errorResponse(
                400,
                "INVALID_ARGUMENTS",
                formatZodError("Invalid preferred device", parsed.error),
                cors
              );
            }
            const preferredDeviceId = parsed.data.device_id;

            await setPreferredDeviceId(env, preferredDeviceId);
            return jsonResponse(
              { ok: true, preferred_device_id: preferredDeviceId },
              200,
              cors
            );
          }

          if (request.method === "DELETE") {
            await clearPreferredDeviceId(env);
            return jsonResponse(
              { ok: true, preferred_device_id: null },
              200,
              cors
            );
          }

          return errorResponse(
            405,
            "METHOD_NOT_ALLOWED",
            "Method not allowed",
            cors
          );
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
