import { spawn } from "child_process";
import os from "os";
import path from "path";
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

function expandHome(input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(1));
  }
  return input;
}

function humanError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

export async function execute_command(args: ExecuteCommandArgs): Promise<ToolResponse> {
  const parsed = ExecuteCommandArgsSchema.parse(args);
  const workdir = parsed.workdir ? expandHome(parsed.workdir) : process.cwd();
  const timeoutMs = parsed.timeout * 1000;

  return new Promise((resolve) => {
    const child = spawn(parsed.command, {
      shell: true,
      cwd: workdir,
      env: { ...process.env, ...parsed.env },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        content: [{ type: "text", text: `Failed to execute command: ${humanError(err, "unknown error")}` }],
        isError: true,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const content: ToolResponse["content"] = [];
      if (stdout) content.push({ type: "text", text: stdout });
      if (stderr) content.push({ type: "text", text: stderr });

      if (killed) {
        resolve({
          content: [{ type: "text", text: `Command timed out after ${parsed.timeout} seconds` }],
          isError: true,
        });
        return;
      }

      resolve({
        content: content.length ? content : [{ type: "text", text: "" }],
        isError: code !== 0,
      });
    });
  });
}

export async function execute_command_stream(
  args: ExecuteCommandStreamArgs,
  onOutput?: (chunk: string) => void,
): Promise<ToolResponse> {
  const parsed = ExecuteCommandStreamArgsSchema.parse(args);
  const workdir = parsed.workdir ? expandHome(parsed.workdir) : process.cwd();

  return new Promise((resolve) => {
    const child = spawn(parsed.command, {
      shell: true,
      cwd: workdir,
    });

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      onOutput?.(text);
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      onOutput?.(text);
    });

    child.on("error", (err) => {
      resolve({
        content: [{ type: "text", text: `Failed to stream command: ${humanError(err, "unknown error")}` }],
        isError: true,
      });
    });

    child.on("close", (code) => {
      resolve({
        content: [{ type: "text", text: `Command exited with code ${code}` }],
        isError: code !== 0,
      });
    });
  });
}

export async function list_processes(args: ListProcessesArgs = {}): Promise<ToolResponse> {
  const parsed = ListProcessesArgsSchema.parse(args);
  const filter = parsed.filter?.toLowerCase();

  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("ps", ["aux"]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", () => resolve({ stdout, stderr }));
    });

    const lines = stdout
      .split("\n")
      .slice(1)
      .filter((line) => {
        if (!line.trim()) return false;
        if (!filter) return true;
        return line.toLowerCase().includes(filter);
      })
      .slice(0, 200);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (err) {
    if (process.platform === "win32" || (err instanceof Error && err.message.includes("ENOENT"))) {
      return {
        content: [{ type: "text", text: "Process listing is not available on this platform" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Failed to list processes: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function kill_process(args: KillProcessArgs): Promise<ToolResponse> {
  const parsed = KillProcessArgsSchema.parse(args);

  try {
    process.kill(parsed.pid, parsed.signal);
    return {
      content: [{ type: "text", text: `Sent ${parsed.signal} to process ${parsed.pid}` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to kill process ${parsed.pid}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}
