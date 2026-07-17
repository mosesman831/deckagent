import type { z } from "zod";
import type { ToolResponse } from "./schemas.js";
import {
  ReadFileArgsSchema,
  WriteFileArgsSchema,
  EditFileArgsSchema,
  SearchFilesArgsSchema,
  ListDirectoryArgsSchema,
  CreateDirectoryArgsSchema,
  MoveFileArgsSchema,
  GetFileInfoArgsSchema,
  ReadMultipleFilesArgsSchema,
  ExecuteCommandArgsSchema,
  ExecuteCommandStreamArgsSchema,
  ListProcessesArgsSchema,
  KillProcessArgsSchema,
  BrowserNavigateArgsSchema,
  BrowserScreenshotArgsSchema,
  BrowserClickArgsSchema,
  BrowserEvaluateArgsSchema,
  GetEnvironmentArgsSchema,
  ListSnapshotsArgsSchema,
  RestoreSnapshotArgsSchema,
} from "./schemas.js";
import {
  read_file,
  write_file,
  edit_file,
  search_files,
  list_directory,
  create_directory,
  move_file,
  get_file_info,
  read_multiple_files,
  setMaxFileReadSize,
  getMaxFileReadSize,
} from "./tools/filesystem.js";
import {
  execute_command,
  execute_command_stream,
  list_processes,
  kill_process,
  killAllActiveCommands,
} from "./tools/terminal.js";
import {
  browser_navigate,
  browser_screenshot,
  browser_click,
  browser_evaluate,
  closeBrowser,
  setBrowserEnabled,
} from "./tools/browser.js";
import { get_environment } from "./tools/environment.js";
import {
  list_snapshots,
  restore_snapshot,
  createSnapshotBeforeMutation,
  setSnapshotsDir,
  getSnapshotsDir,
  setSnapshotRetention,
  resetSnapshotRetention,
} from "./tools/snapshots.js";

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  /** Schema output type is T; input may omit fields that have defaults. */
  inputSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  handler: (args: T) => Promise<ToolResponse>;
}

/** Erase tool argument type for heterogeneous registry storage (no `any`). */
function defineTool<T>(tool: ToolDefinition<T>): ToolDefinition<unknown> {
  return tool as ToolDefinition<unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<unknown>>();

  register<T>(tool: ToolDefinition<T>): void {
    this.tools.set(tool.name, defineTool(tool));
  }

  registerAll(tools: ToolDefinition<unknown>[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): ToolDefinition<unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<unknown>[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, args: unknown): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool not found: ${name}` }],
        isError: true,
      };
    }

    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    try {
      return await tool.handler(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return {
        content: [{ type: "text", text: `Tool "${name}" failed: ${message}` }],
        isError: true,
      };
    }
  }
}

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.registerAll([
    defineTool({
      name: "read_file",
      description:
        "Read the complete contents of a file from the local filesystem. Use for any text-based file. For large files, specify offset and limit.",
      inputSchema: ReadFileArgsSchema,
      handler: read_file,
    }),
    defineTool({
      name: "write_file",
      description:
        "Write content to a file, creating it if it doesn't exist. OVERWRITES existing content. Use edit_file for surgical changes.",
      inputSchema: WriteFileArgsSchema,
      handler: write_file,
    }),
    defineTool({
      name: "edit_file",
      description: "Surgical find-and-replace edit on a file. Replaces exact string match.",
      inputSchema: EditFileArgsSchema,
      handler: edit_file,
    }),
    defineTool({
      name: "search_files",
      description: "Search file contents using ripgrep. Fast regex search across your project.",
      inputSchema: SearchFilesArgsSchema,
      handler: search_files,
    }),
    defineTool({
      name: "list_directory",
      description: "List files and directories in a path with metadata.",
      inputSchema: ListDirectoryArgsSchema,
      handler: list_directory,
    }),
    defineTool({
      name: "create_directory",
      description: "Create a directory and all parent directories if they don't exist.",
      inputSchema: CreateDirectoryArgsSchema,
      handler: create_directory,
    }),
    defineTool({
      name: "move_file",
      description: "Move or rename a file or directory.",
      inputSchema: MoveFileArgsSchema,
      handler: move_file,
    }),
    defineTool({
      name: "get_file_info",
      description: "Get metadata about a file or directory.",
      inputSchema: GetFileInfoArgsSchema,
      handler: get_file_info,
    }),
    defineTool({
      name: "read_multiple_files",
      description: "Read up to 10 files in one call.",
      inputSchema: ReadMultipleFilesArgsSchema,
      handler: read_multiple_files,
    }),
    defineTool({
      name: "execute_command",
      description: "Execute a shell command and return its output.",
      inputSchema: ExecuteCommandArgsSchema,
      handler: execute_command,
    }),
    defineTool({
      name: "execute_command_stream",
      description: "Execute a command and stream output back in real-time.",
      inputSchema: ExecuteCommandStreamArgsSchema,
      handler: (args) => execute_command_stream(args),
    }),
    defineTool({
      name: "list_processes",
      description: "List running processes on the system.",
      inputSchema: ListProcessesArgsSchema,
      handler: list_processes,
    }),
    defineTool({
      name: "kill_process",
      description: "Kill a process by PID.",
      inputSchema: KillProcessArgsSchema,
      handler: kill_process,
    }),
    defineTool({
      name: "browser_navigate",
      description: "Open a URL in the browser. Requires browser automation to be enabled.",
      inputSchema: BrowserNavigateArgsSchema,
      handler: browser_navigate,
    }),
    defineTool({
      name: "browser_screenshot",
      description: "Take a screenshot of the current browser page.",
      inputSchema: BrowserScreenshotArgsSchema,
      handler: browser_screenshot,
    }),
    defineTool({
      name: "browser_click",
      description: "Click an element on the page by selector.",
      inputSchema: BrowserClickArgsSchema,
      handler: browser_click,
    }),
    defineTool({
      name: "browser_evaluate",
      description: "Run JavaScript code in the browser page context.",
      inputSchema: BrowserEvaluateArgsSchema,
      handler: browser_evaluate,
    }),
    defineTool({
      name: "get_environment",
      description: "Get system environment information.",
      inputSchema: GetEnvironmentArgsSchema,
      handler: get_environment,
    }),
    defineTool({
      name: "list_snapshots",
      description:
        "List recent file snapshots taken before mutating edits (write/edit/move). Optionally filter by path.",
      inputSchema: ListSnapshotsArgsSchema,
      handler: list_snapshots,
    }),
    defineTool({
      name: "restore_snapshot",
      description:
        "Restore a file from a previous snapshot by id. Creates a new snapshot of the current file first if it exists.",
      inputSchema: RestoreSnapshotArgsSchema,
      handler: restore_snapshot,
    }),
  ]);

  return registry;
}

export {
  read_file,
  write_file,
  edit_file,
  search_files,
  list_directory,
  create_directory,
  move_file,
  get_file_info,
  read_multiple_files,
  setMaxFileReadSize,
  getMaxFileReadSize,
};
export {
  execute_command,
  execute_command_stream,
  list_processes,
  kill_process,
  killAllActiveCommands,
};
export {
  browser_navigate,
  browser_screenshot,
  browser_click,
  browser_evaluate,
  closeBrowser,
  setBrowserEnabled,
};
export { get_environment };
export {
  list_snapshots,
  restore_snapshot,
  createSnapshotBeforeMutation,
  setSnapshotsDir,
  getSnapshotsDir,
  setSnapshotRetention,
  resetSnapshotRetention,
};
export {
  setWorkspaceContext,
  getWorkspaceContext,
  resolveToolPath,
  type WorkspaceContext,
} from "./workspace-context.js";
