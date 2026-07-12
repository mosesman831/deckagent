import * as os from 'os';
import {
  ToolError,
  ToolRegistry,
  createDefaultToolRegistry,
  toToolError,
} from '@deckagent/mcp-server';
import type { Policy } from './policy.js';
import { resolveAllowedDirectories, validateToolCall, needsConfirmation } from './policy.js';
import { logger } from './logger.js';

/** Worker -> Daemon: request to execute a tool (SPEC §2.5, §3.5). */
export interface ExecuteToolRequest {
  type: 'execute_tool';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Set by the Worker when the user has already approved a confirm-gated tool. */
  _preconfirmed?: boolean;
}

/** Daemon -> Worker: successful tool result. */
export interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  result: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

/** Daemon -> Worker: tool error. */
export interface ToolErrorMessage {
  type: 'tool_error';
  id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ToolResult = ToolResultMessage | ToolErrorMessage;

/**
 * Executes tools coming off the tunnel. Wraps a {@link ToolRegistry} built from
 * `@deckagent/mcp-server` and enforces the security policy before every call.
 */
export class ToolExecutor {
  private registry: ToolRegistry;
  private allowedTools: Set<string>;

  constructor(policy: Policy) {
    this.registry = createDefaultToolRegistry({
      allowedDirectories: resolveAllowedDirectories(policy.allowed_directories),
      maxFileReadSize: policy.max_file_read_size,
      maxCommandTimeout: policy.max_command_timeout,
      homeDir: os.homedir(),
      shell: process.env.SHELL ?? (process.platform === 'win32' ? process.env.ComSpec : '/bin/sh'),
    });
    this.allowedTools = new Set(this.registry.list().map((t) => t.name));
  }

  /** Names of every tool the daemon can execute. */
  listTools(): string[] {
    return Array.from(this.allowedTools);
  }

  /**
   * Validate and execute a single tool request. Never throws: all failures are
   * mapped to a {@link ToolErrorMessage}.
   */
  async execute(request: ExecuteToolRequest, policy: Policy): Promise<ToolResult> {
    const { id, tool, args } = request;

    // 1. Tool must exist / be allowed.
    if (!this.allowedTools.has(tool)) {
      return this.error(id, new ToolError('TOOL_NOT_FOUND', `Tool not found: ${tool}`));
    }

    // 2. Policy checks (read-only, browser/terminal gates, blocked commands,
    //    allowed directories). Confirmation is handled separately below so we
    //    strip it here to honor `_preconfirmed`.
    const policyForValidation: Policy = {
      ...policy,
      require_confirmation: [],
    };
    const validation = validateToolCall(tool, args, policyForValidation);
    if (!validation.allowed) {
      const code = validation.reason?.startsWith('Command blocked')
        ? 'COMMAND_BLOCKED'
        : 'POLICY_BLOCKED';
      return this.error(id, new ToolError(code, validation.reason ?? 'Blocked by policy.'));
    }

    // 3. Confirmation gate.
    if (needsConfirmation(tool, policy.require_confirmation) && !request._preconfirmed) {
      logger.info(`Confirmation required for tool '${tool}' (request ${id}).`);
      return this.error(
        id,
        new ToolError(
          'CONFIRMATION_REQUIRED',
          `Tool '${tool}' requires user confirmation. Retry with _confirm=true to proceed.`,
          { tool, args },
        ),
      );
    }

    // 4. Execute via the registry.
    try {
      logger.debug(`Executing tool '${tool}' (request ${id}).`);
      const response = await this.registry.execute(tool, args);
      return {
        type: 'tool_result',
        id,
        result: { content: response.content, isError: response.isError },
      };
    } catch (err) {
      const toolError = toToolError(err);
      logger.warn(`Tool '${tool}' failed (request ${id}): ${toolError.code} ${toolError.message}`);
      return this.error(id, toolError);
    }
  }

  private error(id: string, err: ToolError): ToolErrorMessage {
    return {
      type: 'tool_error',
      id,
      error: { code: err.code, message: err.message, details: err.details },
    };
  }
}
