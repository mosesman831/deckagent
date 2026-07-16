import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { ToolRegistry } from "@deckagent/mcp-server";
import {
  execute_command_stream,
  killAllActiveCommands,
  setMaxFileReadSize,
} from "@deckagent/mcp-server";
import type { Policy, WorkspacePolicy } from "./policy.js";
import {
  checkToolAllowed,
  applyPathDefaults,
  resolveArgsPaths,
  normalizePolicy,
  getEnabledTools,
  getCapabilities,
} from "./policy.js";
import type { Capabilities } from "./capabilities.js";
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
import { applySecretInjection } from "./secrets.js";
import {
  checkBudget,
  recordToolCall,
  recordShellSeconds,
  recordBytesWritten,
  recordConfirmation,
  getBudgetStatus,
} from "./budgets.js";

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
  /** Active workspace from config (Wave 3 F1). */
  workspace?: WorkspacePolicy | null;
  /** Override audit log directory (tests). */
  auditLogDir?: string;
  /** Custom plugin tools loaded into the registry at daemon startup. */
  pluginToolNames?: readonly string[];
}

/**
 * Shared tool execution path for Worker tunnel and local WS server.
 * Never trusts remote `_preconfirmed`. Blocks on local confirmation UX.
 */
export class ToolExecutor {
  private toolRegistry: ToolRegistry;
  private policy: Policy;
  private workspace: WorkspacePolicy | null;
  private logger: Logger;
  private confirmationServer: ConfirmationServer;
  private toolTimeoutSeconds: number;
  private auditLogDir?: string;
  private pluginToolNames: Set<string>;
  private activeExecutions = new Map<string, AbortController>();

  constructor(options: ToolExecutorOptions) {
    this.toolRegistry = options.toolRegistry;
    this.policy = normalizePolicy(options.policy);
    this.workspace = options.workspace ?? null;
    this.logger = options.logger;
    this.confirmationServer = options.confirmationServer;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.auditLogDir = options.auditLogDir;
    this.pluginToolNames = new Set(options.pluginToolNames ?? []);

    try {
      setMaxFileReadSize(this.policy.max_file_read_size);
    } catch (err) {
      this.logger.warn(
        `Could not set max file read size: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  getPolicy(): Policy {
    return this.policy;
  }

  /** Enabled MCP tool names for Worker tools/list filtering (S2). */
  getEnabledTools(): string[] {
    return getEnabledTools(this.policy, [...this.pluginToolNames]);
  }

  /** Full capability matrix + enabled_tools for policy_caps tunnel message. */
  getCapabilities(): Capabilities {
    return getCapabilities(this.policy);
  }

  getWorkspace(): WorkspacePolicy | null {
    return this.workspace;
  }

  getAuditLogDir(): string | undefined {
    return this.auditLogDir;
  }

  updatePolicy(policy: Policy): void {
    // Always re-normalize so read_only / profile hard forces cannot be skipped.
    this.policy = normalizePolicy(policy);
    try {
      setMaxFileReadSize(this.policy.max_file_read_size);
    } catch {
      // ignore
    }
  }

  updateWorkspace(workspace: WorkspacePolicy | null | undefined): void {
    this.workspace = workspace ?? null;
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
    const isPluginTool = this.pluginToolNames.has(tool);
    this.logger.info(
      isPluginTool ? `Executing plugin:${tool}` : `Executing tool: ${tool}`,
    );

    // Never trust client-controlled confirmation bypass from remote MCP/Worker.
    const args = stripRemoteBypass(rawArgs);
    const argsWithDefaults = applyPathDefaults(tool, args);
    // Absolutize paths for policy + execution (relative → workspace root).
    const resolvedArgs = resolveArgsPaths(
      tool,
      argsWithDefaults,
      this.workspace?.root ?? null,
    );

    // Secret names requested (for audit redaction) — values never logged.
    const requestedSecrets = Array.isArray(resolvedArgs.use_secrets)
      ? resolvedArgs.use_secrets.filter(
          (n): n is string => typeof n === "string" && n.length > 0,
        )
      : [];

    let outcome: ToolExecutionOutcome = {
      ok: false,
      code: "INTERNAL_ERROR",
      message: `Tool '${tool}' failed unexpectedly`,
    };

    try {
      const policyResult = checkToolAllowed(
        tool,
        resolvedArgs,
        this.policy,
        this.workspace,
        [...this.pluginToolNames],
      );

      if (!policyResult.allowed) {
        outcome = {
          ok: false,
          code: policyResult.code ?? "POLICY_BLOCKED",
          message: policyResult.reason || "Blocked by policy",
        };
        return outcome;
      }

      const budgetCheck = checkBudget(this.policy, {
        forConfirmation: !!policyResult.requiresConfirmation,
      });
      if (!budgetCheck.ok) {
        outcome = {
          ok: false,
          code: budgetCheck.code ?? "BUDGET_EXCEEDED",
          message: budgetCheck.message || "Budget exceeded",
        };
        return outcome;
      }

      if (policyResult.requiresConfirmation) {
        recordConfirmation();
        const confirmed = await this.awaitLocalConfirmation(
          tool,
          resolvedArgs,
          policyResult.confirmationReason || `Tool '${tool}' requires confirmation`,
        );
        if (!confirmed.ok) {
          outcome = confirmed;
          return outcome;
        }
      }

      const sizeCheck = checkFileReadSize(tool, resolvedArgs, this.policy);
      if (!sizeCheck.ok) {
        outcome = sizeCheck;
        return outcome;
      }

      // Inject vault secrets into env for terminal tools (vault wins over user env).
      let execArgs = resolvedArgs;
      if (tool === "execute_command" || tool === "execute_command_stream") {
        const injected = applySecretInjection(
          resolvedArgs,
          this.policy.allow_secret_injection,
        );
        execArgs = injected.args;
        if (injected.injected.length > 0) {
          this.logger.info(
            `Injected ${injected.injected.length} secret(s) into '${tool}' env`,
          );
        }
      }

      const timeout = this.resolveTimeout(tool, execArgs);
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
              execArgs as {
                command: string;
                workdir?: string;
                env?: Record<string, string>;
              },
              options.onProgress,
            );
          }
          return this.toolRegistry.execute(tool, execArgs);
        };

        const result = (await this.runWithAbort(
          runTool,
          controller.signal,
        )) as ToolResultPayload;

        let finalResult = result;
        if (tool === "get_environment" && !result.isError) {
          finalResult = appendBudgetSummary(result, this.policy);
        }

        outcome = { ok: true, result: finalResult };

        // Record usage after successful execution.
        recordToolCall();
        if (tool === "execute_command" || tool === "execute_command_stream") {
          recordShellSeconds((Date.now() - started) / 1000);
        }
        if (tool === "write_file" || tool === "edit_file") {
          const bytes = estimateBytesWritten(tool, resolvedArgs);
          if (bytes > 0) recordBytesWritten(bytes);
        }

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
      // Audit uses original resolved args (with use_secrets names) — never secret values.
      const auditArgs =
        tool === "execute_command" || tool === "execute_command_stream"
          ? {
              ...resolvedArgs,
              // Ensure env in audit does not contain vault values if somehow present
              ...(resolvedArgs.env
                ? { env: redactEnvForAuditHint(resolvedArgs.env, requestedSecrets) }
                : {}),
            }
          : resolvedArgs;

      appendAuditLog(
        {
          ts: new Date().toISOString(),
          id,
          tool: isPluginTool ? `plugin:${tool}` : tool,
          args_summary: summarizeArgsForAudit(auditArgs, {
            secretNames: requestedSecrets,
          }),
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

function estimateBytesWritten(
  tool: string,
  args: Record<string, unknown>,
): number {
  if (tool === "write_file" && typeof args.content === "string") {
    return Buffer.byteLength(args.content, "utf-8");
  }
  if (tool === "edit_file" && typeof args.new_string === "string") {
    return Buffer.byteLength(args.new_string, "utf-8");
  }
  return 0;
}

function appendBudgetSummary(
  result: ToolResultPayload,
  policy: Policy,
): ToolResultPayload {
  const status = getBudgetStatus(policy);
  const content = [...(result.content ?? [])];
  const first = content[0];
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      const parsed = JSON.parse(first.text) as Record<string, unknown>;
      parsed.budgets = status;
      content[0] = { ...first, text: JSON.stringify(parsed, null, 2) };
      return { ...result, content };
    } catch {
      content.push({
        type: "text",
        text: `\nBudgets: ${JSON.stringify(status)}`,
      });
      return { ...result, content };
    }
  }
  content.push({
    type: "text",
    text: JSON.stringify({ budgets: status }, null, 2),
  });
  return { ...result, content };
}

/** Never put vault values into audit — redact known secret keys in env snapshot. */
function redactEnvForAuditHint(
  env: unknown,
  secretNames: string[],
): Record<string, unknown> {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    return {};
  }
  return summarizeArgsForAudit(env as Record<string, unknown>, {
    secretNames,
  });
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
