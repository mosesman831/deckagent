import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Tunnel protocol version advertised in auth messages. */
export const PROTOCOL_VERSION = 1;

function resolvePackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "../../package.json"), // dist/src → package root
      join(here, "../package.json"), // src → package root (if run uncompiled)
    ];
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const pkg = JSON.parse(raw) as { version?: string };
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  return "0.1.0";
}

/** Daemon package version from package.json. */
export const DAEMON_VERSION = resolvePackageVersion();
