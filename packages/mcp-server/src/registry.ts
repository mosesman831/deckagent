import { ToolError } from './error.js';
import type { ToolContext, ToolDefinition, ToolResponse } from './types.js';

/**
 * ToolRegistry holds tool definitions and executes them against a shared
 * ToolContext. It is transport-agnostic: no I/O, no server, just a map from
 * tool name to validated handler invocation.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(private context: ToolContext) {}

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition[]): void {
    tools.forEach((t) => this.register(t));
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getContext(): ToolContext {
    return this.context;
  }

  async execute(name: string, args: unknown): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError('TOOL_NOT_FOUND', `Tool not found: ${name}`);
    }
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      throw new ToolError(
        'INVALID_ARGUMENTS',
        `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
        parsed.error.issues,
      );
    }
    return tool.handler(parsed.data, this.context);
  }
}
