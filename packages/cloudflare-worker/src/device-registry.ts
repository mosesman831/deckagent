/**
 * KV helpers for the device registry and OAuth-token/session lookups.
 *
 * Key layout:
 *   device:{device_id}   -> Device (no TTL)
 *   token:{access_token} -> TokenRecord
 *   session:{user_id}    -> Session
 */

import type { Device, DeviceStatus, Env, Session, TokenRecord } from './types.js';

const DEVICE_PREFIX = 'device:';
const TOKEN_PREFIX = 'token:';
const SESSION_PREFIX = 'session:';

export async function getDevice(env: Env, deviceId: string): Promise<Device | null> {
  const raw = await env.DECK_KV.get(`${DEVICE_PREFIX}${deviceId}`);
  return raw ? (JSON.parse(raw) as Device) : null;
}

/** Persist a device. `ttl` of 0 (default) means no expiry. */
export async function putDevice(env: Env, device: Device, ttl = 0): Promise<void> {
  const options = ttl > 0 ? { expirationTtl: ttl } : undefined;
  await env.DECK_KV.put(`${DEVICE_PREFIX}${device.device_id}`, JSON.stringify(device), options);
}

export async function deleteDevice(env: Env, deviceId: string): Promise<void> {
  await env.DECK_KV.delete(`${DEVICE_PREFIX}${deviceId}`);
}

/**
 * Update a device's status (and bump `last_seen`). Returns the updated device,
 * or null if the device does not exist.
 */
export async function updateDeviceStatus(
  env: Env,
  deviceId: string,
  status: DeviceStatus,
): Promise<Device | null> {
  const device = await getDevice(env, deviceId);
  if (!device) return null;
  device.status = status;
  device.last_seen = Date.now();
  await putDevice(env, device);
  return device;
}

/** Update the capabilities advertised by a device. */
export async function updateDeviceCapabilities(
  env: Env,
  deviceId: string,
  capabilities: string[],
): Promise<Device | null> {
  const device = await getDevice(env, deviceId);
  if (!device) return null;
  device.capabilities = capabilities;
  device.last_seen = Date.now();
  await putDevice(env, device);
  return device;
}

export async function getTokenRecord(env: Env, token: string): Promise<TokenRecord | null> {
  const raw = await env.DECK_KV.get(`${TOKEN_PREFIX}${token}`);
  return raw ? (JSON.parse(raw) as TokenRecord) : null;
}

/** Resolve an access token to its owning session, or null if unknown. */
export async function getSessionByToken(env: Env, token: string): Promise<Session | null> {
  const record = await getTokenRecord(env, token);
  if (!record) return null;
  const raw = await env.DECK_KV.get(`${SESSION_PREFIX}${record.user_id}`);
  return raw ? (JSON.parse(raw) as Session) : null;
}
