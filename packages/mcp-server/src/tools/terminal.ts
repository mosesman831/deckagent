import { spawn, type ChildProcess } from "child_process";
import {
  ExecuteCommandArgsSchema,
  ExecuteCommandStreamArgsSchema,
  ListProcessesArgsSchema,
  KillProcessArgsSchema,
  type ExecuteCommandArgs,
  type ExecuteCommandStreamArgs,
  type ListProcessesArgs,
  type KillProcessArgs,
  type ToolResponse,
} from "../schemas.js";
import { resolveToolPath } from "../workspace-context.js";
import { buildSandboxCommand } from "./terminal-sandbox.js";
import type { ToolExecutionContext } from "../index.js";

const activeChildren = new Set<ChildProcess>();
const SIGKILL_DELAY_MS = 500;

function humanError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

function createAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function trackChild(child: ChildProcess): void {
  activeChildren.add(child);
  const cleanup = () => {
    activeChildren.delete(child);
  };
  child.on("close", cleanup);
  child.on("error", cleanup);
}

function forceKill(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, SIGKILL_DELAY_MS);
}

/** Kill all tracked child processes (for abort/shutdown). */
export async function killAllActiveCommands(): Promise<void> {
  const children = Array.from(activeChildren);
  for (const child of children) {
    forceKill(child);
  }
  // Brief wait so SIGKILL can land
  await new Promise((resolve) => setTimeout(resolve, SIGKILL_DELAY_MS + 50));
}

function runShellCommand(
  command: string,
  options: {
    workdir: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    onChunk?: (chunk: string) => void;
    sandbox?: ExecuteCommandArgs["_sandbox"];
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const env = { ...process.env, ...options.env };
    const child = options.sandbox
      ? spawnSandboxedCommand(command, options.workdir, options.sandbox, env)
      : spawn(command, {
          shell: true,
          cwd: options.workdir,
          env,
        });

    trackChild(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (abortListener) {
        options.signal?.removeEventListener("abort", abortListener);
      }
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code, timedOut });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        forceKill(child);
      }, options.timeoutMs);
    }

    abortListener = () => {
      forceKill(child);
      fail(createAbortError());
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      stdout += text;
      options.onChunk?.(text);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      stderr += text;
      options.onChunk?.(text);
    });

    child.on("error", (err) => {
      stderr += humanError(err, "unknown error");
      finish(1);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

function spawnSandboxedCommand(
  command: string,
  workdir: string,
  sandbox: NonNullable<ExecuteCommandArgs["_sandbox"]>,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const sandboxCommand = buildSandboxCommand({
    binary: sandbox.binary,
    trusted_dirs: sandbox.trusted_dirs,
    network: sandbox.network,
    command,
    cwd: workdir,
  });
  return spawn(sandboxCommand.argv[0]!, sandboxCommand.argv.slice(1), {
    shell: false,
    cwd: workdir,
    env: { ...env, ...sandboxCommand.env },
  });
}

export async function execute_command(
  args: ExecuteCommandArgs,
  context?: ToolExecutionContext,
): Promise<ToolResponse> {
  const parsed = ExecuteCommandArgsSchema.parse(args);
  const workdir = parsed.workdir ? resolveToolPath(parsed.workdir) : process.cwd();
  const timeoutMs = parsed.timeout * 1000;

  try {
    const result = await runShellCommand(parsed.command, {
      workdir,
      env: parsed.env,
      timeoutMs,
      sandbox: parsed._sandbox,
      signal: context?.signal,
    });

    if (result.timedOut) {
      return {
        content: [
          {
            type: "text",
            text: `Command timed out after ${parsed.timeout} seconds`,
          },
        ],
        isError: true,
      };
    }

    const content: ToolResponse["content"] = [];
    if (result.stdout) content.push({ type: "text", text: result.stdout });
    if (result.stderr) content.push({ type: "text", text: result.stderr });

    return {
      content: content.length ? content : [{ type: "text", text: "" }],
      isError: result.code !== 0,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        content: [{ type: "text", text: "Command aborted" }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Failed to execute command: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}

export async function execute_command_stream(
  args: ExecuteCommandStreamArgs,
  onChunk?: (chunk: string) => void,
  context?: ToolExecutionContext,
): Promise<ToolResponse> {
  const parsed = ExecuteCommandStreamArgsSchema.parse(args);
  const workdir = parsed.workdir ? resolveToolPath(parsed.workdir) : process.cwd();

  try {
    const result = await runShellCommand(parsed.command, {
      workdir,
      env: parsed.env,
      onChunk,
      sandbox: parsed._sandbox,
      signal: context?.signal,
    });

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(result.stderr);
    parts.push(`Command exited with code ${result.code}`);

    return {
      content: [{ type: "text", text: parts.join("") }],
      isError: result.code !== 0,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        content: [{ type: "text", text: "Command aborted" }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Failed to stream command: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}

async function listProcessesUnix(
  filter?: string,
  sandbox?: ExecuteCommandArgs["_sandbox"],
): Promise<string> {
  const result = await runShellCommand("ps aux", {
    workdir: process.cwd(),
    sandbox,
  });
  if (result.code !== 0 && !result.stdout) {
    throw new Error(result.stderr || "ps aux failed");
  }

  return result.stdout
    .split("\n")
    .slice(1)
    .filter((line) => {
      if (!line.trim()) return false;
      if (!filter) return true;
      return line.toLowerCase().includes(filter);
    })
    .slice(0, 200)
    .join("\n");
}

async function listProcessesWindows(
  filter?: string,
  sandbox?: ExecuteCommandArgs["_sandbox"],
): Promise<string> {
  // Prefer tasklist CSV for reliable parsing; fall back to PowerShell / wmic.
  const attempts = [
    'tasklist /FO CSV /NH',
    'powershell -NoProfile -Command "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet | Format-Table -AutoSize | Out-String -Width 200"',
    "wmic process get ProcessId,Name,WorkingSetSize /FORMAT:CSV",
  ];

  let lastError = "unknown error";
  for (const command of attempts) {
    const result = await runShellCommand(command, {
      workdir: process.cwd(),
      sandbox,
    });
    if (result.stdout.trim()) {
      const lines = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .filter((line) => {
          if (!filter) return true;
          return line.toLowerCase().includes(filter);
        })
        .slice(0, 200);
      return lines.join("\n");
    }
    lastError = result.stderr || `command failed: ${command}`;
  }

  throw new Error(lastError);
}

export async function list_processes(args: ListProcessesArgs = {}): Promise<ToolResponse> {
  const parsed = ListProcessesArgsSchema.parse(args);
  const filter = parsed.filter?.toLowerCase();

  try {
    const text =
      process.platform === "win32"
        ? await listProcessesWindows(filter, parsed._sandbox)
        : await listProcessesUnix(filter, parsed._sandbox);

    return {
      content: [{ type: "text", text: text || "No matching processes" }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to list processes: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}

export async function kill_process(args: KillProcessArgs): Promise<ToolResponse> {
  const parsed = KillProcessArgsSchema.parse(args);

  try {
    if (process.platform === "win32") {
      const signal = parsed.signal.toUpperCase();
      const force = signal === "SIGKILL" || signal === "KILL";
      const result = await runShellCommand(
        force ? `taskkill /PID ${parsed.pid} /F` : `taskkill /PID ${parsed.pid}`,
        { workdir: process.cwd() },
      );
      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to kill process ${parsed.pid}: ${result.stderr || result.stdout || "taskkill failed"}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Sent ${parsed.signal} to process ${parsed.pid}` }],
      };
    }

    process.kill(parsed.pid, parsed.signal);
    return {
      content: [{ type: "text", text: `Sent ${parsed.signal} to process ${parsed.pid}` }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to kill process ${parsed.pid}: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}
