/**
 * Tunnel protocol version handshake between Worker and desktop daemon.
 * Bump MIN_PROTOCOL_VERSION when the Worker requires a newer daemon.
 */
export const MIN_PROTOCOL_VERSION = 1;
export const WORKER_VERSION = "0.1.0";

export type ProtocolCheckResult =
  | { ok: true; warning?: "upgrade_daemon" }
  | { ok: false; reason: "protocol_mismatch" };

/**
 * Validate the daemon's reported tunnel protocol_version.
 * - Missing → accept with upgrade warning (legacy daemons).
 * - Present but below MIN → reject with protocol_mismatch.
 */
export function checkProtocolVersion(
  protocolVersion?: number
): ProtocolCheckResult {
  if (protocolVersion === undefined || protocolVersion === null) {
    return { ok: true, warning: "upgrade_daemon" };
  }
  if (
    typeof protocolVersion !== "number" ||
    !Number.isFinite(protocolVersion) ||
    protocolVersion < MIN_PROTOCOL_VERSION
  ) {
    return { ok: false, reason: "protocol_mismatch" };
  }
  return { ok: true };
}
