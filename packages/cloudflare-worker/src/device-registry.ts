import type { Env, DeviceInfo, DeviceStatus } from "./types.js";

const DEVICE_PREFIX = "device:";
const DEVICE_TTL = 90; // seconds for status/ping refresh

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
  await env.DECK_KV.put(`${DEVICE_PREFIX}${deviceId}`, JSON.stringify(info));
}

export async function removeDevice(env: Env, deviceId: string): Promise<void> {
  await env.DECK_KV.delete(`${DEVICE_PREFIX}${deviceId}`);
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

export async function updateDeviceStatus(
  env: Env,
  deviceId: string,
  status: DeviceStatus
): Promise<void> {
  const device = await getDevice(env, deviceId);
  if (!device) return;
  device.status = status;
  device.last_seen = Date.now();
  await env.DECK_KV.put(
    `${DEVICE_PREFIX}${deviceId}`,
    JSON.stringify(device),
    status === "online" ? { expirationTtl: DEVICE_TTL } : undefined
  );
}
