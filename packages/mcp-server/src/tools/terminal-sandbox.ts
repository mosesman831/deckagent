import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TerminalSandboxPlan } from "../schemas.js";

export interface SandboxCommandOptions extends TerminalSandboxPlan {
  command: string;
  cwd: string;
}

export interface SandboxCommand {
  argv: string[];
  env?: Record<string, string>;
}

const LINUX_SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc",
  "/sbin",
] as const;

const DARWIN_SYSTEM_PATHS = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
] as const;

function systemReadPaths(): readonly string[] {
  return process.platform === "darwin" ? DARWIN_SYSTEM_PATHS : LINUX_SYSTEM_PATHS;
}

function pathExists(inputPath: string): boolean {
  try {
    return existsSync(inputPath);
  } catch {
    return false;
  }
}

function assertExecutableFile(binary: string): void {
  try {
    const st = statSync(binary);
    if (!st.isFile()) {
      throw new Error(`Sandbox binary is not a file: ${binary}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Sandbox binary")) {
      throw err;
    }
    throw new Error(`Sandbox binary is unavailable: ${binary}`);
  }
}

function uniqNormalized(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function isInsideOrEqual(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function chdirForSandbox(cwd: string, trustedDirs: readonly string[]): string {
  const resolved = path.resolve(cwd);
  for (const trusted of trustedDirs) {
    if (isInsideOrEqual(resolved, trusted) && pathExists(resolved)) {
      return resolved;
    }
  }
  return "/";
}

function buildBubblewrapCommand(opts: SandboxCommandOptions): SandboxCommand {
  const trustedDirs = uniqNormalized(opts.trusted_dirs);
  const argv = [opts.binary, "--die-with-parent"];

  for (const systemPath of systemReadPaths()) {
    if (pathExists(systemPath)) {
      argv.push("--ro-bind", systemPath, systemPath);
    }
  }

  // Give commands a private scratch area without exposing the host /tmp.
  argv.push("--tmpfs", "/tmp");

  for (const trusted of trustedDirs) {
    if (pathExists(trusted)) {
      argv.push("--bind", trusted, trusted);
    }
  }

  argv.push("--chdir", chdirForSandbox(opts.cwd, trustedDirs));
  argv.push("--deadend", "/proc");

  if (!opts.network) {
    argv.push("--unshare-net");
  }

  argv.push("--", "/bin/sh", "-c", opts.command);
  return { argv };
}

function escapeSandboxString(value: string): string {
  return JSON.stringify(value);
}

function buildSandboxExecProfile(trustedDirs: readonly string[], network: boolean): string {
  const readSystemPaths = systemReadPaths().filter(pathExists);
  const readRules = [...readSystemPaths, ...trustedDirs]
    .map((p) => `  (subpath ${escapeSandboxString(p)})`)
    .join("\n");
  const writeRules = trustedDirs
    .map((p) => `  (subpath ${escapeSandboxString(p)})`)
    .join("\n");

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    readRules ? `(allow file-read*\n${readRules})` : "",
    writeRules ? `(allow file-write*\n${writeRules})` : "",
    network ? "(allow network*)" : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSandboxExecCommand(opts: SandboxCommandOptions): SandboxCommand {
  const trustedDirs = uniqNormalized(opts.trusted_dirs);
  const tmpDir = path.join(homedir(), ".deckagent", "tmp");
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const profilePath = path.join(
    tmpDir,
    `sandbox-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sb`,
  );
  writeFileSync(profilePath, buildSandboxExecProfile(trustedDirs, opts.network), {
    encoding: "utf-8",
    mode: 0o600,
  });

  return {
    argv: [opts.binary, "-f", profilePath, "/bin/sh", "-c", opts.command],
  };
}

/**
 * Build an argv-only sandbox invocation. Callers must spawn argv[0] with
 * shell:false; falling back to a raw shell would violate terminal_mode=sandbox_fs.
 */
export function buildSandboxCommand(opts: SandboxCommandOptions): SandboxCommand {
  assertExecutableFile(opts.binary);
  const name = path.basename(opts.binary);

  if (name === "bwrap") {
    return buildBubblewrapCommand(opts);
  }

  if (name === "sandbox-exec") {
    return buildSandboxExecCommand(opts);
  }

  throw new Error(
    `Unsupported sandbox binary '${name}'. Expected bwrap or sandbox-exec.`,
  );
}
