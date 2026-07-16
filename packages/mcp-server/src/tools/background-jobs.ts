import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  CancelJobArgsSchema,
  GetJobArgsSchema,
  JOB_TIMEOUT_MAX_MS,
  ListJobsArgsSchema,
  StartJobArgsSchema,
  type CancelJobArgs,
  type GetJobArgs,
  type JobStatus,
  type ListJobsArgs,
  type StartJobArgs,
  type ToolResponse,
} from "../schemas.js";
import { resolveToolPath } from "../workspace-context.js";
import { buildSandboxCommand } from "./terminal-sandbox.js";
import type { ToolExecutionContext } from "../index.js";

const MAX_CONCURRENT_JOBS = 5;
const LOG_CAP_BYTES = 5 * 1024 * 1024;
const SIGKILL_DELAY_MS = 500;

interface JobMeta {
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  pid: number | null;
  started_at: string;
  updated_at: string;
  ended_at?: string;
  timeout_ms: number;
  exit_code?: number | null;
  signal?: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  error?: string;
}

interface ActiveJob {
  child: ChildProcess;
  meta: JobMeta;
  startedAtMs: number;
  stdoutStream: ReturnType<typeof createWriteStream>;
  stderrStream: ReturnType<typeof createWriteStream>;
  timeout: ReturnType<typeof setTimeout>;
  shellSecondsRecorder?: (seconds: number) => void;
}

const activeJobs = new Map<string, ActiveJob>();
let jobsRoot = join(homedir(), ".deckagent", "jobs");

export function getJobsDir(): string {
  return jobsRoot;
}

export function setJobsDirForTest(path: string | null): void {
  jobsRoot = path ?? join(homedir(), ".deckagent", "jobs");
}

function jobDir(jobId: string): string {
  return join(jobsRoot, jobId);
}

function metaPath(jobId: string): string {
  return join(jobDir(jobId), "meta.json");
}

function stdoutPath(jobId: string): string {
  return join(jobDir(jobId), "stdout.log");
}

function stderrPath(jobId: string): string {
  return join(jobDir(jobId), "stderr.log");
}

function humanError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

function jsonResponse(value: unknown, isError = false): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function writeMeta(meta: JobMeta): Promise<void> {
  const path = metaPath(meta.id);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(meta, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(tempPath, path);
}

async function readMeta(jobId: string): Promise<JobMeta | null> {
  try {
    const raw = await readFile(metaPath(jobId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<JobMeta>;
    if (typeof parsed.id !== "string" || parsed.id !== jobId) {
      return null;
    }
    if (typeof parsed.command !== "string" || typeof parsed.cwd !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      command: parsed.command,
      cwd: parsed.cwd,
      status: normalizeStatus(parsed.status),
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
      ended_at: typeof parsed.ended_at === "string" ? parsed.ended_at : undefined,
      timeout_ms: typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : JOB_TIMEOUT_MAX_MS,
      exit_code:
        typeof parsed.exit_code === "number" || parsed.exit_code === null
          ? parsed.exit_code
          : undefined,
      signal:
        typeof parsed.signal === "string" || parsed.signal === null ? parsed.signal : undefined,
      stdout_bytes: typeof parsed.stdout_bytes === "number" ? parsed.stdout_bytes : 0,
      stderr_bytes: typeof parsed.stderr_bytes === "number" ? parsed.stderr_bytes : 0,
      stdout_truncated: parsed.stdout_truncated === true,
      stderr_truncated: parsed.stderr_truncated === true,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): JobStatus {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
    case "timed_out":
      return value;
    default:
      return "failed";
  }
}

async function readAllMetas(): Promise<JobMeta[]> {
  try {
    const entries = await readdir(jobsRoot, { withFileTypes: true });
    const metas = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readMeta(entry.name)),
    );
    return metas.filter((meta): meta is JobMeta => meta !== null);
  } catch {
    return [];
  }
}

function isRunningStatus(status: JobStatus): boolean {
  return status === "running";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function refreshRunningMeta(meta: JobMeta): Promise<JobMeta> {
  const active = activeJobs.get(meta.id);
  if (active) {
    return active.meta;
  }
  if (!isRunningStatus(meta.status)) {
    return meta;
  }
  if (meta.pid !== null && isProcessAlive(meta.pid)) {
    return meta;
  }
  const now = new Date().toISOString();
  const next: JobMeta = {
    ...meta,
    status: "failed",
    ended_at: meta.ended_at ?? now,
    updated_at: now,
    error: "Job process is no longer running and exit status was unavailable",
  };
  await writeMeta(next).catch(() => undefined);
  return next;
}

async function countRunningJobs(): Promise<number> {
  const metas = await readAllMetas();
  let count = 0;
  for (const meta of metas) {
    const refreshed = await refreshRunningMeta(meta);
    if (refreshed.status === "running") {
      count += 1;
    }
  }
  return count;
}

function spawnJobProcess(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  sandbox: StartJobArgs["_sandbox"],
): ChildProcess {
  if (sandbox) {
    const sandboxCommand = buildSandboxCommand({
      binary: sandbox.binary,
      trusted_dirs: sandbox.trusted_dirs,
      network: sandbox.network,
      command,
      cwd,
    });
    return spawn(sandboxCommand.argv[0]!, sandboxCommand.argv.slice(1), {
      shell: false,
      cwd,
      env: { ...env, ...sandboxCommand.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  return spawn(command, {
    shell: true,
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function appendCappedLog(active: ActiveJob, stream: "stdout" | "stderr", chunk: Buffer): void {
  const bytesKey = stream === "stdout" ? "stdout_bytes" : "stderr_bytes";
  const truncatedKey = stream === "stdout" ? "stdout_truncated" : "stderr_truncated";
  const writer = stream === "stdout" ? active.stdoutStream : active.stderrStream;
  const current = active.meta[bytesKey];
  const remaining = LOG_CAP_BYTES - current;

  if (remaining <= 0) {
    active.meta[truncatedKey] = true;
    return;
  }

  const toWrite = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  writer.write(toWrite);
  active.meta[bytesKey] += toWrite.byteLength;
  if (toWrite.byteLength < chunk.byteLength) {
    active.meta[truncatedKey] = true;
  }
}

function endStreams(active: ActiveJob): void {
  active.stdoutStream.end();
  active.stderrStream.end();
}

function killJobProcess(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct process when process-group signaling is unavailable.
    }
  }
  process.kill(pid, signal);
}

function scheduleForceKill(pid: number): void {
  setTimeout(() => {
    try {
      killJobProcess(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }, SIGKILL_DELAY_MS);
}

async function readTail(filePath: string, lines: number): Promise<string> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function publicMeta(meta: JobMeta): Record<string, unknown> {
  return {
    job_id: meta.id,
    command: meta.command,
    cwd: meta.cwd,
    status: meta.status,
    pid: meta.pid,
    started_at: meta.started_at,
    updated_at: meta.updated_at,
    ended_at: meta.ended_at ?? null,
    timeout_ms: meta.timeout_ms,
    exit_code: meta.exit_code ?? null,
    signal: meta.signal ?? null,
    stdout_bytes: meta.stdout_bytes,
    stderr_bytes: meta.stderr_bytes,
    stdout_truncated: meta.stdout_truncated,
    stderr_truncated: meta.stderr_truncated,
    error: meta.error ?? null,
  };
}

export async function start_job(
  args: StartJobArgs,
  context?: ToolExecutionContext,
): Promise<ToolResponse> {
  const parsed = StartJobArgsSchema.parse(args);
  const cwd = parsed.cwd ? resolveToolPath(parsed.cwd) : process.cwd();
  const timeoutMs = Math.min(parsed.timeout_ms, JOB_TIMEOUT_MAX_MS);

  if (context?.signal?.aborted) {
    return jsonResponse({ error: "Job start aborted" }, true);
  }

  try {
    const running = await countRunningJobs();
    if (running >= MAX_CONCURRENT_JOBS) {
      return jsonResponse(
        {
          error: `Cannot start job: maximum concurrent jobs reached (${MAX_CONCURRENT_JOBS})`,
        },
        true,
      );
    }

    await stat(cwd);
  } catch (err) {
    return jsonResponse(
      {
        error: `Cannot start job: ${humanError(err, "failed to inspect working directory")}`,
      },
      true,
    );
  }

  const id = randomUUID();
  const dir = jobDir(id);
  const now = new Date().toISOString();
  const meta: JobMeta = {
    id,
    command: parsed.command,
    cwd,
    status: "running",
    pid: null,
    started_at: now,
    updated_at: now,
    timeout_ms: timeoutMs,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
  };

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(stdoutPath(id), "", { mode: 0o600 });
    await writeFile(stderrPath(id), "", { mode: 0o600 });

    const child = spawnJobProcess(parsed.command, cwd, { ...process.env, ...parsed.env }, parsed._sandbox);
    meta.pid = child.pid ?? null;

    const timeout = setTimeout(() => {
      const current = activeJobs.get(id);
      if (!current || current.meta.status !== "running" || current.meta.pid === null) return;
      current.meta.status = "timed_out";
      current.meta.error = `Job timed out after ${timeoutMs}ms`;
      try {
        killJobProcess(current.meta.pid, "SIGTERM");
        scheduleForceKill(current.meta.pid);
      } catch {
        // Process may already be gone; close handler will finalize metadata.
      }
    }, timeoutMs);

    const active: ActiveJob = {
      child,
      meta,
      startedAtMs: Date.now(),
      stdoutStream: createWriteStream(stdoutPath(id), { flags: "a", mode: 0o600 }),
      stderrStream: createWriteStream(stderrPath(id), { flags: "a", mode: 0o600 }),
      timeout,
      shellSecondsRecorder: context?.onShellSeconds,
    };
    activeJobs.set(id, active);

    child.stdout?.on("data", (data: Buffer) => appendCappedLog(active, "stdout", data));
    child.stderr?.on("data", (data: Buffer) => appendCappedLog(active, "stderr", data));

    child.on("error", (err) => {
      active.meta.status = "failed";
      active.meta.error = `Failed to run job: ${humanError(err, "unknown error")}`;
    });

    child.on("close", (code, signal) => {
      clearTimeout(active.timeout);
      const ended = new Date().toISOString();
      const previousStatus = active.meta.status;
      active.meta.status =
        previousStatus === "cancelled" || previousStatus === "timed_out"
          ? previousStatus
          : code === 0
            ? "completed"
            : "failed";
      active.meta.exit_code = code;
      active.meta.signal = signal;
      active.meta.ended_at = ended;
      active.meta.updated_at = ended;
      active.shellSecondsRecorder?.((Date.now() - active.startedAtMs) / 1000);
      endStreams(active);
      activeJobs.delete(id);
      void writeMeta(active.meta).catch(() => undefined);
    });

    await writeMeta(meta);
    if (meta.status !== "running") {
      await writeMeta(meta);
    }

    return jsonResponse({ job_id: id, status: "running" });
  } catch (err) {
    return jsonResponse(
      {
        error: `Cannot start job: ${humanError(err, "unknown error")}`,
      },
      true,
    );
  }
}

export async function list_jobs(args: ListJobsArgs = {}): Promise<ToolResponse> {
  const parsed = ListJobsArgsSchema.parse(args);
  try {
    const metas = await Promise.all((await readAllMetas()).map(refreshRunningMeta));
    const jobs = metas
      .filter((meta) => !parsed.status || meta.status === parsed.status)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .map(publicMeta);
    return jsonResponse({ jobs, count: jobs.length });
  } catch (err) {
    return jsonResponse(
      { error: `Failed to list jobs: ${humanError(err, "unknown error")}` },
      true,
    );
  }
}

export async function get_job(args: GetJobArgs): Promise<ToolResponse> {
  const parsed = GetJobArgsSchema.parse(args);
  try {
    const meta = await readMeta(parsed.job_id);
    if (!meta) {
      return jsonResponse({ error: `Job not found: ${parsed.job_id}` }, true);
    }
    const refreshed = await refreshRunningMeta(meta);
    const [stdout, stderr] = await Promise.all([
      readTail(stdoutPath(parsed.job_id), parsed.tail_lines),
      readTail(stderrPath(parsed.job_id), parsed.tail_lines),
    ]);
    return jsonResponse({
      ...publicMeta(refreshed),
      stdout,
      stderr,
    });
  } catch (err) {
    return jsonResponse(
      { error: `Failed to get job: ${humanError(err, "unknown error")}` },
      true,
    );
  }
}

export async function cancel_job(args: CancelJobArgs): Promise<ToolResponse> {
  const parsed = CancelJobArgsSchema.parse(args);
  try {
    const meta = await readMeta(parsed.job_id);
    if (!meta) {
      return jsonResponse({ error: `Job not found: ${parsed.job_id}` }, true);
    }
    const refreshed = await refreshRunningMeta(meta);
    if (refreshed.status !== "running" || refreshed.pid === null) {
      return jsonResponse(
        {
          error: `Job ${parsed.job_id} is not running (status: ${refreshed.status})`,
        },
        true,
      );
    }

    const active = activeJobs.get(parsed.job_id);
    if (active) {
      active.meta.status = "cancelled";
      active.meta.updated_at = new Date().toISOString();
      await writeMeta(active.meta);
    } else {
      refreshed.status = "cancelled";
      refreshed.updated_at = new Date().toISOString();
      await writeMeta(refreshed);
    }

    killJobProcess(refreshed.pid, "SIGTERM");
    scheduleForceKill(refreshed.pid);
    return jsonResponse({ job_id: parsed.job_id, status: "cancelled" });
  } catch (err) {
    return jsonResponse(
      { error: `Failed to cancel job: ${humanError(err, "unknown error")}` },
      true,
    );
  }
}
