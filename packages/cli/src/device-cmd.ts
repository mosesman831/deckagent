import { z } from 'zod';
import {
  readConfig as readConfigFile,
  writeConfig as writeConfigFile,
  type Config
} from './configure.js';

const DeviceIdSchema = z.string().uuid();

export interface DeviceSummary {
  id: string;
  name: string;
  status: 'online' | 'offline';
  last_seen: number | null;
}

export interface DevicesResponse {
  preferred_device_id: string | null;
  devices: DeviceSummary[];
}

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<Response>;

export interface DeviceCommandOptions {
  readConfig?: () => Config;
  writeConfig?: (config: Config) => void;
  fetch?: FetchLike;
}

function getFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch !== 'function') {
    throw new Error('This command requires Node.js fetch support. Use Node 18 or newer.');
  }
  return fetch;
}

function workerApiUrl(config: Config, pathname: string): URL {
  return new URL(pathname, config.worker_url);
}

function parseDeviceId(raw: string): string {
  const result = DeviceIdSchema.safeParse(raw);
  if (!result.success) {
    throw new Error('Invalid device_id. Expected a UUID.');
  }
  return result.data;
}

function authHeaders(config: Config): Record<string, string> {
  return {
    Authorization: `Bearer ${config.api_token}`,
    Accept: 'application/json'
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function responseErrorMessage(status: number, payload: Record<string, unknown>): string {
  const message = payload.message;
  if (typeof message === 'string' && message.trim()) {
    return message;
  }
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return `Worker request failed with HTTP ${status}`;
}

async function requestWorkerJson<T>(
  config: Config,
  pathname: string,
  init: {
    method: string;
    body?: Record<string, unknown>;
  },
  fetchImpl: FetchLike
): Promise<T> {
  const headers = authHeaders(config);
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  const response = await fetchImpl(workerApiUrl(config, pathname), {
    method: init.method,
    headers,
    body
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Worker returned a non-JSON response (HTTP ${response.status}).`);
  }

  const objectPayload = parseJsonObject(payload);
  if (!response.ok) {
    throw new Error(responseErrorMessage(response.status, objectPayload));
  }

  return objectPayload as T;
}

export async function listWorkerDevices(
  config: Config,
  fetchImpl: FetchLike = getFetch()
): Promise<DevicesResponse> {
  return requestWorkerJson<DevicesResponse>(
    config,
    '/api/devices',
    { method: 'GET' },
    fetchImpl
  );
}

export async function preferWorkerDevice(
  config: Config,
  deviceId: string,
  fetchImpl: FetchLike = getFetch()
): Promise<void> {
  const preferredDeviceId = parseDeviceId(deviceId);
  await requestWorkerJson<{ ok?: boolean; preferred_device_id?: string }>(
    config,
    '/api/devices/prefer',
    { method: 'PUT', body: { device_id: preferredDeviceId } },
    fetchImpl
  );
}

export async function clearWorkerPreferredDevice(
  config: Config,
  fetchImpl: FetchLike = getFetch()
): Promise<void> {
  await requestWorkerJson<{ ok?: boolean; preferred_device_id?: null }>(
    config,
    '/api/devices/prefer',
    { method: 'DELETE' },
    fetchImpl
  );
}

export async function revokeWorkerDevice(
  config: Config,
  deviceId: string,
  fetchImpl: FetchLike = getFetch()
): Promise<void> {
  const revokeDeviceId = parseDeviceId(deviceId);
  await requestWorkerJson<{ ok?: boolean }>(
    config,
    `/api/devices/${encodeURIComponent(revokeDeviceId)}`,
    { method: 'DELETE' },
    fetchImpl
  );
}

function formatLastSeen(lastSeen: number | null): string {
  if (lastSeen === null) return 'never';
  const date = new Date(lastSeen);
  if (Number.isNaN(date.getTime())) return String(lastSeen);
  return date.toISOString();
}

function printDeviceList(response: DevicesResponse): void {
  console.log(`Preferred device: ${response.preferred_device_id ?? '(none)'}`);
  if (response.devices.length === 0) {
    console.log('No devices registered.');
    return;
  }

  console.log('Devices:');
  for (const device of response.devices) {
    const marker = device.id === response.preferred_device_id ? '*' : ' ';
    console.log(
      `${marker} ${device.id}  ${device.status}  ${device.name}  last_seen=${formatLastSeen(device.last_seen)}`
    );
  }
}

function printHelp(): void {
  console.log(`Usage:
  deckagent device list
  deckagent device prefer <device_id>
  deckagent device revoke <device_id> [--yes]
  deckagent device clear
`);
}

export async function runDeviceCommand(
  args: string[],
  options: DeviceCommandOptions = {}
): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  const readConfig = options.readConfig ?? readConfigFile;
  const writeConfig = options.writeConfig ?? writeConfigFile;
  const fetchImpl = getFetch(options.fetch);

  switch (sub) {
    case 'list': {
      const config = readConfig();
      const response = await listWorkerDevices(config, fetchImpl);
      printDeviceList(response);
      break;
    }

    case 'prefer': {
      const rawDeviceId = args[1];
      if (!rawDeviceId) {
        throw new Error('Missing device_id. Usage: deckagent device prefer <device_id>');
      }
      const preferredDeviceId = parseDeviceId(rawDeviceId);
      const config = readConfig();
      await preferWorkerDevice(config, preferredDeviceId, fetchImpl);
      writeConfig({ ...config, preferred_device_id: preferredDeviceId });
      console.log(`Preferred device set: ${preferredDeviceId}`);
      break;
    }

    case 'revoke': {
      const rawDeviceId = args[1];
      if (!rawDeviceId) {
        throw new Error('Missing device_id. Usage: deckagent device revoke <device_id> [--yes]');
      }
      const revokeDeviceId = parseDeviceId(rawDeviceId);
      const yes = args.includes('--yes') || args.includes('-y');
      const config = readConfig();
      if (revokeDeviceId === config.device_id && !yes) {
        throw new Error(
          'Refusing to revoke this device without --yes. Self-revoke will unregister this daemon until you run setup again.'
        );
      }
      if (revokeDeviceId === config.device_id) {
        console.warn(
          'Warning: revoking this device will disconnect the daemon until you run `deckagent setup` again.'
        );
      }
      await revokeWorkerDevice(config, revokeDeviceId, fetchImpl);
      console.log(`Device revoked: ${revokeDeviceId}`);
      break;
    }

    case 'clear': {
      const config = readConfig();
      await clearWorkerPreferredDevice(config, fetchImpl);
      const { preferred_device_id: _removed, ...rest } = config;
      writeConfig(rest);
      console.log('Preferred device cleared.');
      break;
    }

    default:
      throw new Error(`Unknown device command: ${sub}. Use: list | prefer | revoke | clear`);
  }
}
