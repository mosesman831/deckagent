import * as os from 'os';
import { ToolRegistry } from './registry.js';
import type { ToolContext, ToolDefinition } from './types.js';
import { TerminalManager } from './tools/terminal.js';
import { BrowserManager } from './tools/browser.js';
import { toolDefinitions as filesystemTools } from './tools/filesystem.js';
import { toolDefinitions as terminalTools } from './tools/terminal.js';
import { toolDefinitions as browserTools } from './tools/browser.js';
import { toolDefinitions as environmentTools } from './tools/environment.js';

// Core exports
export { ToolError, toToolError } from './error.js';
export { ToolRegistry } from './registry.js';
export type { ToolContext, ToolResponse, ToolDefinition, ToolContentBlock } from './types.js';

// Schemas
export { schemas } from './schemas.js';
export * as schemaDefs from './schemas.js';

// Managers
export { TerminalManager } from './tools/terminal.js';
export { BrowserManager } from './tools/browser.js';
export type { CommandResult } from './tools/terminal.js';

// Tool-definition arrays
export { toolDefinitions as filesystemTools } from './tools/filesystem.js';
export { toolDefinitions as terminalTools } from './tools/terminal.js';
export { toolDefinitions as browserTools } from './tools/browser.js';
export { toolDefinitions as environmentTools } from './tools/environment.js';

// Utils
export { validatePath, expandHome, isPathAllowed, formatFileSize } from './utils/paths.js';
export { findBlockMatches, replaceBlock } from './utils/fuzzy.js';

const DEFAULT_MAX_FILE_READ_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_COMMAND_TIMEOUT = 300; // seconds

/** Every built-in tool definition, in registration order. */
export const allToolDefinitions: ToolDefinition[] = [
  ...filesystemTools,
  ...terminalTools,
  ...browserTools,
  ...environmentTools,
];

/**
 * Create a ToolRegistry with all built-in tools registered and sensible
 * defaults filled into the context. Pass a partial context to override
 * managers or policy-ish settings (e.g. allowedDirectories).
 */
export function createDefaultToolRegistry(context: Partial<ToolContext> = {}): ToolRegistry {
  const homeDir = context.homeDir ?? os.homedir();
  const fullContext: ToolContext = {
    terminalManager: context.terminalManager ?? new TerminalManager(homeDir),
    browserManager: context.browserManager ?? new BrowserManager(),
    allowedDirectories: context.allowedDirectories ?? [],
    maxFileReadSize: context.maxFileReadSize ?? DEFAULT_MAX_FILE_READ_SIZE,
    maxCommandTimeout: context.maxCommandTimeout ?? DEFAULT_MAX_COMMAND_TIMEOUT,
    homeDir,
    shell: context.shell ?? (process.platform === 'win32' ? process.env.ComSpec : process.env.SHELL),
  };

  const registry = new ToolRegistry(fullContext);
  registry.registerAll(allToolDefinitions);
  return registry;
}
