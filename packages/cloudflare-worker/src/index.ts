/**
 * DeckAgent Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /               -> health check ("OK")
 *   GET  /auth/github    -> begin GitHub OAuth (PKCE)
 *   GET  /auth/callback  -> finish OAuth, mint access token
 *   POST /api/devices    -> register a device (deploy-secret protected)
 *   GET  /mcp            -> tools/list JSON
 *   POST /mcp            -> MCP Streamable HTTP (OAuth bearer protected)
 *   GET  /tunnel         -> WebSocket tunnel for the desktop daemon
 */

import { z } from 'zod';

import { handleAuthCallback, handleAuthGithub } from './auth.js';
import { putDevice } from './device-registry.js';
import { handleMcp } from './mcp-handler.js';
import { handleTunnel } from './tunnel.js';
import type { Device, Env } from './types.js';

const DEPLOY_SECRET_KEY = 'deploy:secret';

const DeviceRegistrationSchema = z.object({
  device_id: z.string().min(1),
  name: z.string().min(1),
  token: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
});

function extractBearer(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * `POST /api/devices` — register a device. Protected by a deploy secret stored
 * in KV. If none is set yet, the first caller's bearer is adopted as the deploy
 * secret (trust-on-first-use during CLI setup).
 */
async function handleDeviceRegistration(request: Request, env: Env): Promise<Response> {
  const provided = extractBearer(request);
  if (!provided) {
    return jsonError(401, 'UNAUTHORIZED', 'Missing deploy secret');
  }

  const stored = await env.DECK_KV.get(DEPLOY_SECRET_KEY);
  if (stored) {
    if (provided !== stored) {
      return jsonError(401, 'UNAUTHORIZED', 'Invalid deploy secret');
    }
  } else {
    await env.DECK_KV.put(DEPLOY_SECRET_KEY, provided);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_ARGUMENTS', 'Request body must be valid JSON');
  }

  const parsed = DeviceRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'INVALID_ARGUMENTS', parsed.error.message);
  }

  const device: Device = {
    device_id: parsed.data.device_id,
    name: parsed.data.name,
    status: 'offline',
    ip: request.headers.get('CF-Connecting-IP') ?? '',
    last_seen: Date.now(),
    capabilities: parsed.data.capabilities,
    token: parsed.data.token,
  };
  await putDevice(env, device);

  return new Response(
    JSON.stringify({ ok: true, device_id: device.device_id }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (pathname === '/' && method === 'GET') {
      return new Response('OK', { status: 200 });
    }
    if (pathname === '/auth/github' && method === 'GET') {
      return handleAuthGithub(request, env);
    }
    if (pathname === '/auth/callback' && method === 'GET') {
      return handleAuthCallback(request, env);
    }
    if (pathname === '/api/devices' && method === 'POST') {
      return handleDeviceRegistration(request, env);
    }
    if (pathname === '/mcp' && (method === 'GET' || method === 'POST')) {
      return handleMcp(request, env, ctx);
    }
    if (pathname === '/tunnel' && method === 'GET') {
      return handleTunnel(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
