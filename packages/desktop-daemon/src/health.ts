import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { DAEMON_VERSION } from "./version.js";

export const HealthTunnelStateSchema = z.enum([
  "connected",
  "connecting",
  "disconnected",
]);

export type HealthTunnelState = z.infer<typeof HealthTunnelStateSchema>;

export const DaemonHealthSchema = z
  .object({
    ok: z.boolean(),
    pid: z.number().int().nonnegative(),
    device_id: z.string().min(1),
    tunnel: HealthTunnelStateSchema,
    last_heartbeat_at: z.string().datetime(),
    worker_url: z.string().url(),
    version: z.string().min(1),
    connected_at: z.string().datetime().nullable(),
    last_disconnect_at: z.string().datetime().nullable(),
    last_disconnect_reason: z.string().nullable(),
    reconnect_attempt: z.number().int().nonnegative(),
    next_reconnect_at: z.string().datetime().nullable(),
    worker_version: z.string().min(1).optional(),
    protocol_warning: z.string().min(1).optional(),
  })
  .strict();

export type DaemonHealth = z.infer<typeof DaemonHealthSchema>;

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
    connectedAt?: Date | string | null;
    lastDisconnectAt?: Date | string | null;
    lastDisconnectReason?: string | null;
    reconnectAttempt?: number;
    nextReconnectAt?: Date | string | null;
  } = {},
): DaemonHealth {
  const heartbeatAt = options.lastHeartbeatAt ?? new Date();
  return {
    ok: options.ok ?? tunnel === "connected",
    pid: options.pid ?? process.pid,
    device_id: config.device_id,
    tunnel,
    last_heartbeat_at: heartbeatAt.toISOString(),
    worker_url: config.worker_url,
    version: options.version ?? DAEMON_VERSION,
    connected_at:
      isoOrNull(options.connectedAt) ??
      (tunnel === "connected" ? heartbeatAt.toISOString() : null),
    last_disconnect_at: isoOrNull(options.lastDisconnectAt),
    last_disconnect_reason: options.lastDisconnectReason ?? null,
    reconnect_attempt: options.reconnectAttempt ?? 0,
    next_reconnect_at: isoOrNull(options.nextReconnectAt),
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
  const parsed = DaemonHealthSchema.parse(health);
  writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tempPath, healthPath);
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}
