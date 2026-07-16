import type { Env, DeviceInfo, DeviceStatus } from "./types.js";

const DEVICE_PREFIX = "device:";
const DEVICE_ONLINE_PREFIX = "device_online:";
const DEFAULT_DEVICE_PREF_KEY = "pref:default_device";
/** Presence TTL (seconds). Registration keys never use this. */
const PRESENCE_TTL = 90;

export interface DeviceSummary {
  id: string;
  name: string;
  status: DeviceStatus;
  capabilities: string[];
  last_seen: number | null;
}

export async function getDevice(
  env: Env,
  deviceId: string
): Promise<DeviceInfo | null> {
  const raw = await env.DECK_KV.get(`${DEVICE_PREFIX}${deviceId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeviceInfo;
  } catch {
    return null;
  }
}

export async function setDevice(
  env: Env,
  deviceId: string,
  info: DeviceInfo
): Promise<void> {
  // Registration must never expire — token_hash must survive disconnects.
  await env.DECK_KV.put(`${DEVICE_PREFIX}${deviceId}`, JSON.stringify(info));
}

export async function removeDevice(env: Env, deviceId: string): Promise<void> {
  await env.DECK_KV.delete(`${DEVICE_PREFIX}${deviceId}`);
  await env.DECK_KV.delete(`${DEVICE_ONLINE_PREFIX}${deviceId}`);
}

function constantTimeEquals(a: string, b: string): boolean {
  let result = 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export async function authenticateDevice(
  env: Env,
  deviceId: string,
  token: string
): Promise<DeviceInfo | null> {
  const device = await getDevice(env, deviceId);
  if (!device) return null;
  const tokenHash = await hashToken(token);
  if (!constantTimeEquals(device.token_hash, tokenHash)) return null;
  return device;
}

/**
 * Update device status/last_seen on the permanent registration record.
 * Presence is tracked separately via `device_online:{id}` with a short TTL
 * so unclean disconnects never wipe token_hash registration.
 */
export async function updateDeviceStatus(
  env: Env,
  deviceId: string,
  status: DeviceStatus
): Promise<void> {
  const device = await getDevice(env, deviceId);
  if (!device) return;
  device.status = status;
  device.last_seen = Date.now();
  // Never set expirationTtl on the registration key.
  await env.DECK_KV.put(`${DEVICE_PREFIX}${deviceId}`, JSON.stringify(device));

  const presenceKey = `${DEVICE_ONLINE_PREFIX}${deviceId}`;
  if (status === "online") {
    await env.DECK_KV.put(presenceKey, "1", { expirationTtl: PRESENCE_TTL });
  } else {
    await env.DECK_KV.delete(presenceKey);
  }
}

export async function isDeviceOnline(
  env: Env,
  deviceId: string
): Promise<boolean> {
  const raw = await env.DECK_KV.get(`${DEVICE_ONLINE_PREFIX}${deviceId}`);
  return raw !== null;
}

/** List device IDs currently marked online via presence keys. */
export async function listOnlineDevices(env: Env): Promise<string[]> {
  const listed = await env.DECK_KV.list({ prefix: DEVICE_ONLINE_PREFIX });
  return listed.keys.map((k) => k.name.slice(DEVICE_ONLINE_PREFIX.length));
}

/** List all registered device IDs (online or offline). */
export async function listRegisteredDeviceIds(env: Env): Promise<string[]> {
  const listed = await env.DECK_KV.list({ prefix: DEVICE_PREFIX });
  return listed.keys.map((k) => k.name.slice(DEVICE_PREFIX.length));
}

export async function getPreferredDeviceId(env: Env): Promise<string | null> {
  const raw = await env.DECK_KV.get(DEFAULT_DEVICE_PREF_KEY);
  const preferred = raw?.trim();
  return preferred ? preferred : null;
}

export async function setPreferredDeviceId(
  env: Env,
  deviceId: string
): Promise<void> {
  await env.DECK_KV.put(DEFAULT_DEVICE_PREF_KEY, deviceId);
}

export async function clearPreferredDeviceId(env: Env): Promise<void> {
  await env.DECK_KV.delete(DEFAULT_DEVICE_PREF_KEY);
}

export async function listDevices(env: Env): Promise<DeviceSummary[]> {
  const registeredIds = await listRegisteredDeviceIds(env);
  const onlineIds = new Set(await listOnlineDevices(env));

  const devices: DeviceSummary[] = [];
  for (const id of registeredIds) {
    const info = await getDevice(env, id);
    if (!info) continue;
    devices.push({
      id: info.id,
      name: info.name,
      status: onlineIds.has(id) ? "online" : "offline",
      capabilities: info.capabilities,
      last_seen: info.last_seen,
    });
  }

  // Include any online presence keys that somehow lack registration.
  for (const id of onlineIds) {
    if (registeredIds.includes(id)) continue;
    devices.push({
      id,
      name: id,
      status: "online",
      capabilities: [],
      last_seen: null,
    });
  }

  return devices;
}

/**
 * Resolve which device should handle a tools/call.
 * - Explicit params.deviceId: use it (must be online).
 * - Header X-DeckAgent-Device-Id: use it (must be online).
 * - Sticky preferred device: use it if online.
 * - Otherwise use the sole online device, or error if zero/multiple.
 */
export async function resolveTargetDeviceId(
  env: Env,
  requestedDeviceId?: string,
  headerDeviceId?: string | null
): Promise<{ deviceId: string } | { error: string; message: string }> {
  const explicitDeviceId = requestedDeviceId?.trim();
  if (explicitDeviceId) {
    const online = await isDeviceOnline(env, explicitDeviceId);
    if (!online) {
      return {
        error: "DEVICE_OFFLINE",
        message: `Device '${explicitDeviceId}' is not online`,
      };
    }
    return { deviceId: explicitDeviceId };
  }

  const headerTarget = headerDeviceId?.trim();
  if (headerTarget) {
    const online = await isDeviceOnline(env, headerTarget);
    if (!online) {
      return {
        error: "DEVICE_OFFLINE",
        message: `Device '${headerTarget}' is not online`,
      };
    }
    return { deviceId: headerTarget };
  }

  const online = await listOnlineDevices(env);
  if (online.length === 0) {
    return {
      error: "DEVICE_OFFLINE",
      message: "No daemon connected. Start the desktop daemon and try again.",
    };
  }

  const preferredDeviceId = await getPreferredDeviceId(env);
  if (preferredDeviceId && online.includes(preferredDeviceId)) {
    return { deviceId: preferredDeviceId };
  }

  if (online.length > 1) {
    return {
      error: "DEVICE_AMBIGUOUS",
      message: `Multiple devices online (${online.join(", ")}). Specify params.deviceId.`,
    };
  }
  return { deviceId: online[0] };
}
