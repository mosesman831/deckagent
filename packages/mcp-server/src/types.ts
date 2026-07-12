import type { z } from 'zod';
import type { TerminalManager } from './tools/terminal.js';
import type { BrowserManager } from './tools/browser.js';

/**
 * Execution context passed to every tool handler. It holds the shared
 * long-lived managers (terminal, browser) plus resolved policy-ish defaults.
 */
export interface ToolContext {
  terminalManager: TerminalManager;
  browserManager: BrowserManager;
  allowedDirectories?: string[];
  maxFileReadSize?: number;
  maxCommandTimeout?: number;
  homeDir?: string;
  shell?: string;
}

/** A single content block in a tool response. */
export interface ToolContentBlock {
  type: string;
  text: string;
}

/** The normalized response returned by every tool handler. */
export interface ToolResponse {
  content: ToolContentBlock[];
  isError?: boolean;
}

/**
 * A tool definition: name, description, Zod input schema, and an async handler
 * that receives the parsed args and the shared context.
 */
export interface ToolDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: T;
  handler: (args: z.infer<T>, context: ToolContext) => Promise<ToolResponse>;
}
