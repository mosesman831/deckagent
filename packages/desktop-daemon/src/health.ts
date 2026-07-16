import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { DAEMON_VERSION } from "./version.js";

export type HealthTunnelState =
  | "connected"
  | "connecting"
  | "disconnected";

export interface DaemonHealth {
  ok: boolean;
  pid: number;
  device_id: string;
  tunnel: HealthTunnelState;
  last_heartbeat_at: string;
  worker_url: string;
  version: string;
  worker_version?: string;
  protocol_warning?: string;
}

export function getHealthPath(baseDir = join(homedir(), ".deckagent")): string {
  return join(baseDir, "health.json");
}

export function buildDaemonHealth(
  config: Pick<Config, "device_id" | "worker_url">,
  tunnel: HealthTunnelState,
  options: {
    ok?: boolean;
    lastHeartbeatAt?: Date;
    pid?: number;
    version?: string;
    workerVersion?: string;
    protocolWarning?: string;
  } = {},
): DaemonHealth {
  return {
    ok: options.ok ?? tunnel === "connected",
    pid: options.pid ?? process.pid,
    device_id: config.device_id,
    tunnel,
    last_heartbeat_at: (options.lastHeartbeatAt ?? new Date()).toISOString(),
    worker_url: config.worker_url,
    version: options.version ?? DAEMON_VERSION,
    ...(options.workerVersion ? { worker_version: options.workerVersion } : {}),
    ...(options.protocolWarning
      ? { protocol_warning: options.protocolWarning }
      : {}),
  };
}

export function writeDaemonHealth(
  health: DaemonHealth,
  healthPath = getHealthPath(),
): void {
  const dir = dirname(healthPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${healthPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(health, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tempPath, healthPath);
}
