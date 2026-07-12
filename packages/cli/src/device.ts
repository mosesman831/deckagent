import { hostname, homedir } from "node:os";
import {
  type Config,
  configExists,
  generateDeviceId,
  generateToken,
  loadPartialConfig,
  prompt,
  saveConfig,
} from "./config.js";
import { getWorkerDir } from "./config.js";
import { wranglerCapture } from "./deploy.js";

const DEFAULT_CAPABILITIES = ["filesystem", "terminal", "browser"];

export interface RegisterOptions {
  deviceName?: string;
  deploySecret?: string;
  workerUrl?: string;
  yes?: boolean;
}

/** Read the deploy secret from KV via wrangler (best-effort). */
export function readDeploySecretFromKv(): string | null {
  const result = wranglerCapture(
    ["kv", "key", "get", "deploy:secret", "--binding", "DECK_KV", "--remote"],
    getWorkerDir(),
  );
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return null;
}

/**
 * Register (or re-register) this device with the Worker.
 * Generates device_id/token if missing, POSTs to {worker_url}/api/devices,
 * and persists config.json.
 */
export async function registerDevice(
  options: RegisterOptions = {},
  home: string = homedir(),
): Promise<Config> {
  const partial = configExists(home) ? loadPartialConfig(home) : {};

  const workerUrl = (options.workerUrl ?? partial.worker_url ?? "").replace(/\/$/, "");
  if (!workerUrl) {
    throw new Error(
      "No worker_url available. Run `deckagent deploy`/`deckagent setup` or pass --worker-url.",
    );
  }

  const deviceName =
    options.deviceName ?? partial.device_name ?? hostname();
  const deviceId = partial.device_id ?? generateDeviceId();
  const token = partial.token ?? generateToken();

  let deploySecret = options.deploySecret ?? readDeploySecretFromKv() ?? "";
  if (!deploySecret && !options.yes) {
    deploySecret = await prompt(
      "Enter the deploy secret (from `deckagent setup`, stored in KV as deploy:secret)",
    );
  }
  if (!deploySecret) {
    throw new Error(
      "A deploy secret is required to register a device. Pass --deploy-secret or run `deckagent setup`.",
    );
  }

  const config: Config = {
    device_id: deviceId,
    token,
    worker_url: workerUrl,
    device_name: deviceName,
    heartbeat_interval: partial.heartbeat_interval ?? 15,
    tool_timeout: partial.tool_timeout ?? 60,
    auto_connect: partial.auto_connect ?? true,
    log_level: partial.log_level ?? "info",
  };

  await postDevice(workerUrl, deploySecret, {
    device_id: deviceId,
    name: deviceName,
    token,
    capabilities: DEFAULT_CAPABILITIES,
  });

  saveConfig(config, home);
  console.log(`Device registered: ${deviceName} (${deviceId})`);
  return config;
}

export interface DevicePayload {
  device_id: string;
  name: string;
  token: string;
  capabilities: string[];
}

export async function postDevice(
  workerUrl: string,
  deploySecret: string,
  payload: DevicePayload,
): Promise<void> {
  const url = `${workerUrl}/api/devices`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deploySecret}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Failed to reach ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Device registration failed (${res.status} ${res.statusText})${text ? `: ${text}` : ""}`,
    );
  }
}
