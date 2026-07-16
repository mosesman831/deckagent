import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { ToolRegistry } from "@deckagent/mcp-server";
import {
  execute_command_stream,
  killAllActiveCommands,
  setMaxFileReadSize,
} from "@deckagent/mcp-server";
import type { Policy } from "./policy.js";
import { checkToolAllowed, applyPathDefaults } from "./policy.js";
import type { Logger } from "./logger.js";
import {
  ConfirmationServer,
  CONFIRMATION_WAIT_MS,
} from "./confirmation-server.js";
import {
  appendAuditLog,
  summarizeArgsForAudit,
  type AuditSource,
} from "./audit-log.js";
import { sendDesktopNotification } from "./notify.js";

export interface ToolResultPayload {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export type ToolExecutionOutcome =
  | { ok: true; result: ToolResultPayload }
  | {
      ok: false;
      code: string;
      message: string;
    };

export interface ToolExecutorOptions {
  toolRegistry: ToolRegistry;
  policy: Policy;
  logger: Logger;
  confirmationServer: ConfirmationServer;
  toolTimeoutSeconds: number;
  /** Override audit log directory (tests). */
  auditLogDir?: string;
}

/**
 * Shared tool execution path for Worker tunnel and local WS server.
 * Never trusts remote `_preconfirmed`. Blocks on local confirmation UX.
 */
export class ToolExecutor {
  private toolRegistry: ToolRegistry;
  private policy: Policy;
  private logger: Logger;
  private confirmationServer: ConfirmationServer;
  private toolTimeoutSeconds: number;
  private auditLogDir?: string;
  private activeExecutions = new Map<string, AbortController>();

  constructor(options: ToolExecutorOptions) {
    this.toolRegistry = options.toolRegistry;
    this.policy = options.policy;
    this.logger = options.logger;
    this.confirmationServer = options.confirmationServer;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.auditLogDir = options.auditLogDir;

    try {
      setMaxFileReadSize(this.policy.max_file_read_size);
    } catch (err) {
      this.logger.warn(
        `Could not set max file read size: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  updatePolicy(policy: Policy): void {
    this.policy = policy;
    try {
      setMaxFileReadSize(policy.max_file_read_size);
    } catch {
      // ignore
    }
  }

  abortAll(): void {
    for (const [id, controller] of this.activeExecutions) {
      controller.abort();
      this.activeExecutions.delete(id);
    }
    void killAllActiveCommands().catch(() => {
      // best-effort
    });
  }

  abort(id: string): void {
    const controller = this.activeExecutions.get(id);
    if (controller) {
      controller.abort();
    }
    this.activeExecutions.delete(id);
  }

  async execute(
    id: string,
    tool: string,
    rawArgs: Record<string, unknown>,
    options?: {
      onProgress?: (chunk: string) => void;
      source?: AuditSource;
    },
  ): Promise<ToolExecutionOutcome> {
    const started = Date.now();
    const source: AuditSource = options?.source ?? "tunnel";
    this.logger.info(`Executing tool: ${tool}`);

    // Never trust client-controlled confirmation bypass from remote MCP/Worker.
    const args = stripRemoteBypass(rawArgs);
    const argsWithDefaults = applyPathDefaults(tool, args);

    let outcome: ToolExecutionOutcome = {
      ok: false,
      code: "INTERNAL_ERROR",
      message: `Tool '${tool}' failed unexpectedly`,
    };

    try {
      const policyResult = checkToolAllowed(tool, argsWithDefaults, this.policy);

      if (!policyResult.allowed) {
        outcome = {
          ok: false,
          code: "POLICY_BLOCKED",
          message: policyResult.reason || "Blocked by policy",
        };
        return outcome;
      }

      if (policyResult.requiresConfirmation) {
        const confirmed = await this.awaitLocalConfirmation(
          tool,
          argsWithDefaults,
          policyResult.confirmationReason || `Tool '${tool}' requires confirmation`,
        );
        if (!confirmed.ok) {
          outcome = confirmed;
          return outcome;
        }
      }

      const sizeCheck = checkFileReadSize(tool, argsWithDefaults, this.policy);
      if (!sizeCheck.ok) {
        outcome = sizeCheck;
        return outcome;
      }

      const timeout = this.resolveTimeout(tool, argsWithDefaults);
      const controller = new AbortController();
      this.activeExecutions.set(id, controller);

      const timeoutTimer = setTimeout(() => {
        controller.abort();
      }, timeout);

      const onAbort = () => {
        void killAllActiveCommands().catch(() => {
          // best-effort
        });
      };
      controller.signal.addEventListener("abort", onAbort);

      try {
        const runTool = () => {
          if (tool === "execute_command_stream" && options?.onProgress) {
            return execute_command_stream(
              argsWithDefaults as { command: string; workdir?: string },
              options.onProgress,
            );
          }
          return this.toolRegistry.execute(tool, argsWithDefaults);
        };

        const result = (await this.runWithAbort(
          runTool,
          controller.signal,
        )) as ToolResultPayload;

        outcome = { ok: true, result };
        return outcome;
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          outcome = {
            ok: false,
            code: "TOOL_TIMEOUT",
            message: `Tool '${tool}' timed out after ${timeout}ms`,
          };
          return outcome;
        }
        outcome = {
          ok: false,
          code: "INTERNAL_ERROR",
          message: `Tool '${tool}' failed: ${humanError(err)}`,
        };
        return outcome;
      } finally {
        clearTimeout(timeoutTimer);
        controller.signal.removeEventListener("abort", onAbort);
        this.activeExecutions.delete(id);
      }
    } finally {
      appendAuditLog(
        {
          ts: new Date().toISOString(),
          id,
          tool,
          args_summary: summarizeArgsForAudit(argsWithDefaults),
          outcome: outcome.ok ? "ok" : "error",
          code: outcome.ok ? undefined : outcome.code,
          duration_ms: Date.now() - started,
          source,
        },
        this.auditLogDir ? { logDir: this.auditLogDir } : undefined,
      );
    }
  }

  private async awaitLocalConfirmation(
    tool: string,
    args: Record<string, unknown>,
    reason: string,
  ): Promise<ToolExecutionOutcome | { ok: true }> {
    const { id, url } = this.confirmationServer.createApproval({
      tool,
      args,
      reason,
    });

    const banner = `APPROVAL NEEDED: open ${url}`;
    this.logger.warn(banner);
    // Always print prominently even if logger is not foreground.
    process.stderr.write(`\n*** ${banner} ***\n`);
    process.stderr.write(
      `    Approve or deny within ${Math.round(CONFIRMATION_WAIT_MS / 1000)}s to continue.\n\n`,
    );

    // Best-effort OS notification — never fail the tool flow.
    try {
      sendDesktopNotification(
        "DeckAgent approval needed",
        `${tool} — open ${url}`,
      );
    } catch {
      // ignore
    }

    this.confirmationServer.openInBrowser(url);

    const decision = await this.confirmationServer.waitForDecision(
      id,
      CONFIRMATION_WAIT_MS,
    );

    if (decision === "approved") {
      this.logger.info(`Confirmation approved for '${tool}' (${id})`);
      return { ok: true };
    }

    if (decision === "denied") {
      return {
        ok: false,
        code: "CONFIRMATION_DENIED",
        message: `User denied confirmation for tool '${tool}'. Review at ${url}`,
      };
    }

    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message:
        `Confirmation required for tool '${tool}' but was not approved in time (${decision}). ` +
        `Open ${url} to approve, then retry. Reason: ${reason}`,
    };
  }

  private runWithAbort<T>(
    fn: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }

      let settled = false;
      fn().then(
        (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );

      signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }

  private resolveTimeout(
    toolName: string,
    args: Record<string, unknown>,
  ): number {
    if (
      toolName === "execute_command" ||
      toolName === "execute_command_stream"
    ) {
      const requested =
        typeof args.timeout === "number"
          ? args.timeout * 1000
          : this.toolTimeoutSeconds * 1000;
      return Math.min(requested, this.policy.max_command_timeout * 1000);
    }

    return this.toolTimeoutSeconds * 1000;
  }
}

function stripRemoteBypass(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  delete next._preconfirmed;
  delete next.preconfirmed;
  delete next.__preconfirmed;
  return next;
}

function checkFileReadSize(
  tool: string,
  args: Record<string, unknown>,
  policy: Policy,
): ToolExecutionOutcome | { ok: true } {
  if (tool !== "read_file" && tool !== "read_multiple_files") {
    return { ok: true };
  }

  const paths: string[] = [];
  if (typeof args.path === "string") paths.push(args.path);
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string") paths.push(p);
    }
  }

  for (const p of paths) {
    const resolved = expandHome(p);
    try {
      const st = statSync(resolved);
      if (st.isFile() && st.size > policy.max_file_read_size) {
        return {
          ok: false,
          code: "POLICY_BLOCKED",
          message: `File '${p}' exceeds max_file_read_size (${st.size} > ${policy.max_file_read_size} bytes)`,
        };
      }
    } catch {
      // Missing files are handled by the tool itself.
    }
  }

  return { ok: true };
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return resolvePath(inputPath);
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
