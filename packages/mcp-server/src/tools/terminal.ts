import { exec, spawn } from 'child_process';
import * as os from 'os';
import { ToolError, toToolError } from '../error.js';
import type { ToolContext, ToolDefinition, ToolResponse } from '../types.js';
import {
  ExecuteCommandArgsSchema,
  ExecuteCommandStreamArgsSchema,
  ListProcessesArgsSchema,
  KillProcessArgsSchema,
} from '../schemas.js';

const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const DEFAULT_STREAM_TIMEOUT = 300; // seconds

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

type ExecArgs = {
  command: string;
  workdir?: string;
  timeout: number;
  env?: Record<string, string>;
};

type StreamArgs = {
  command: string;
  workdir?: string;
};

/**
 * TerminalManager owns command execution. It is a thin, testable wrapper around
 * child_process that returns structured results and throws ToolError on timeout.
 */
export class TerminalManager {
  constructor(private cwd: string = os.homedir()) {}

  private resolveCwd(workdir?: string): string {
    return workdir && workdir.length > 0 ? workdir : this.cwd;
  }

  executeCommand(args: ExecArgs): Promise<CommandResult> {
    const timeoutMs = args.timeout * 1000;
    const cwd = this.resolveCwd(args.workdir);
    const env = { ...process.env, ...(args.env ?? {}) };

    return new Promise<CommandResult>((resolve, reject) => {
      exec(
        args.command,
        { cwd, env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: 'SIGTERM' },
        (error, stdout, stderr) => {
          if (error) {
            const errno = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
            if (errno.killed && errno.signal === 'SIGTERM') {
              reject(
                new ToolError(
                  'TOOL_TIMEOUT',
                  `Command timed out after ${args.timeout} seconds`,
                  { command: args.command, timeout: args.timeout, partial_output: stdout },
                ),
              );
              return;
            }
            const exitCode = typeof errno.code === 'number' ? errno.code : 1;
            resolve({ stdout, stderr, exitCode, timedOut: false });
            return;
          }
          resolve({ stdout, stderr, exitCode: 0, timedOut: false });
        },
      );
    });
  }

  executeCommandStream(args: StreamArgs, maxTimeoutSeconds: number = DEFAULT_STREAM_TIMEOUT): Promise<CommandResult> {
    const cwd = this.resolveCwd(args.workdir);
    const timeoutMs = maxTimeoutSeconds * 1000;

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(args.command, { shell: true, cwd, env: process.env });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(
          new ToolError('TOOL_TIMEOUT', `Command timed out after ${maxTimeoutSeconds} seconds`, {
            command: args.command,
            timeout: maxTimeoutSeconds,
            partial_output: stdout,
          }),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(toToolError(err));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 0, timedOut: false });
      });
    });
  }
}

function commandResponse(result: CommandResult): ToolResponse {
  const content: Array<{ type: string; text: string }> = [];
  content.push({ type: 'text', text: result.stdout });
  if (result.stderr.length > 0) {
    content.push({ type: 'text', text: result.stderr });
  }
  return { content, isError: result.exitCode !== 0 || undefined };
}

async function listProcesses(filter?: string): Promise<string> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'tasklist' : 'ps aux';
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(cmd, { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(toToolError(error));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  let lines = result.stdout.split('\n');
  const header = lines.length > 0 ? lines[0] : '';
  if (filter) {
    const f = filter.toLowerCase();
    const body = lines.slice(1).filter((l) => l.toLowerCase().includes(f));
    lines = [header, ...body];
  }
  return lines.join('\n');
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'execute_command',
    description:
      'Execute a shell command and return its output. Use for running scripts, builds, tests, and git operations. Timeout defaults to 60s (max 300s).',
    inputSchema: ExecuteCommandArgsSchema,
    handler: async (args, context: ToolContext) => {
      const result = await context.terminalManager.executeCommand(args);
      return commandResponse(result);
    },
  },
  {
    name: 'execute_command_stream',
    description:
      'Execute a command, collecting its output until completion. Intended for long-running commands. In v1 the collected output is returned once the command finishes.',
    inputSchema: ExecuteCommandStreamArgsSchema,
    handler: async (args, context: ToolContext) => {
      const result = await context.terminalManager.executeCommandStream(
        args,
        context.maxCommandTimeout ?? DEFAULT_STREAM_TIMEOUT,
      );
      return commandResponse(result);
    },
  },
  {
    name: 'list_processes',
    description: 'List running processes on the system. Optionally filter by a substring of the process line.',
    inputSchema: ListProcessesArgsSchema,
    handler: async (args) => {
      const text = await listProcesses(args.filter);
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'kill_process',
    description: 'Kill a process by PID, optionally with a specific signal (default SIGTERM).',
    inputSchema: KillProcessArgsSchema,
    handler: async (args) => {
      try {
        process.kill(args.pid, args.signal as NodeJS.Signals);
        return { content: [{ type: 'text', text: `Sent ${args.signal} to process ${args.pid}` }] };
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ESRCH') {
          throw new ToolError('INTERNAL_ERROR', `No such process: ${args.pid}`);
        }
        if (e.code === 'EPERM') {
          throw new ToolError('INTERNAL_ERROR', `Permission denied to signal process ${args.pid}`);
        }
        throw toToolError(err);
      }
    },
  },
];
