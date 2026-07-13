import { z } from "zod";
import type {
  ReadFileArgs,
  WriteFileArgs,
  EditFileArgs,
  SearchFilesArgs,
  ListDirectoryArgs,
  CreateDirectoryArgs,
  MoveFileArgs,
  GetFileInfoArgs,
  ReadMultipleFilesArgs,
  ExecuteCommandArgs,
  ExecuteCommandStreamArgs,
  ListProcessesArgs,
  KillProcessArgs,
  BrowserNavigateArgs,
  BrowserScreenshotArgs,
  BrowserClickArgs,
  BrowserEvaluateArgs,
  GetEnvironmentArgs,
  ToolResponse,
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
} from "./tools/filesystem.js";
import {
  execute_command,
  execute_command_stream,
  list_processes,
  kill_process,
} from "./tools/terminal.js";
import {
  browser_navigate,
  browser_screenshot,
  browser_click,
  browser_evaluate,
} from "./tools/browser.js";
import { get_environment } from "./tools/environment.js";

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  handler: (args: T) => Promise<ToolResponse>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any>>();

  register<T>(tool: ToolDefinition<T>): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition<any>[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<any>[] {
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

    return tool.handler(parsed.data);
  }
}

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.registerAll([
    {
      name: "read_file",
      description: "Read the complete contents of a file from the local filesystem. Use for any text-based file. For large files, specify offset and limit.",
      inputSchema: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }) as z.ZodType<ReadFileArgs>,
      handler: read_file,
    },
    {
      name: "write_file",
      description: "Write content to a file, creating it if it doesn't exist. OVERWRITES existing content. Use edit_file for surgical changes.",
      inputSchema: z.object({ path: z.string(), content: z.string() }) as z.ZodType<WriteFileArgs>,
      handler: write_file,
    },
    {
      name: "edit_file",
      description: "Surgical find-and-replace edit on a file. Replaces exact string match.",
      inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }) as z.ZodType<EditFileArgs>,
      handler: edit_file,
    },
    {
      name: "search_files",
      description: "Search file contents using ripgrep. Fast regex search across your project.",
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), file_glob: z.string().optional(), max_results: z.number().optional() }) as z.ZodType<SearchFilesArgs>,
      handler: search_files,
    },
    {
      name: "list_directory",
      description: "List files and directories in a path with metadata.",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<ListDirectoryArgs>,
      handler: list_directory,
    },
    {
      name: "create_directory",
      description: "Create a directory and all parent directories if they don't exist.",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<CreateDirectoryArgs>,
      handler: create_directory,
    },
    {
      name: "move_file",
      description: "Move or rename a file or directory.",
      inputSchema: z.object({ source: z.string(), destination: z.string() }) as z.ZodType<MoveFileArgs>,
      handler: move_file,
    },
    {
      name: "get_file_info",
      description: "Get metadata about a file or directory.",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<GetFileInfoArgs>,
      handler: get_file_info,
    },
    {
      name: "read_multiple_files",
      description: "Read up to 10 files in one call.",
      inputSchema: z.object({ paths: z.array(z.string()) }) as z.ZodType<ReadMultipleFilesArgs>,
      handler: read_multiple_files,
    },
    {
      name: "execute_command",
      description: "Execute a shell command and return its output.",
      inputSchema: z.object({ command: z.string(), workdir: z.string().optional(), timeout: z.number().optional(), env: z.record(z.string()).optional() }) as z.ZodType<ExecuteCommandArgs>,
      handler: execute_command,
    },
    {
      name: "execute_command_stream",
      description: "Execute a command and stream output back in real-time.",
      inputSchema: z.object({ command: z.string(), workdir: z.string().optional() }) as z.ZodType<ExecuteCommandStreamArgs>,
      handler: (args) => execute_command_stream(args),
    },
    {
      name: "list_processes",
      description: "List running processes on the system.",
      inputSchema: z.object({ filter: z.string().optional() }) as z.ZodType<ListProcessesArgs>,
      handler: list_processes,
    },
    {
      name: "kill_process",
      description: "Kill a process by PID.",
      inputSchema: z.object({ pid: z.number(), signal: z.string().optional() }) as z.ZodType<KillProcessArgs>,
      handler: kill_process,
    },
    {
      name: "browser_navigate",
      description: "Open a URL in the browser. Requires browser automation to be enabled.",
      inputSchema: z.object({ url: z.string(), headless: z.boolean().optional() }) as z.ZodType<BrowserNavigateArgs>,
      handler: browser_navigate,
    },
    {
      name: "browser_screenshot",
      description: "Take a screenshot of the current browser page.",
      inputSchema: z.object({ full_page: z.boolean().optional() }) as z.ZodType<BrowserScreenshotArgs>,
      handler: browser_screenshot,
    },
    {
      name: "browser_click",
      description: "Click an element on the page by selector.",
      inputSchema: z.object({ selector: z.string() }) as z.ZodType<BrowserClickArgs>,
      handler: browser_click,
    },
    {
      name: "browser_evaluate",
      description: "Run JavaScript code in the browser page context.",
      inputSchema: z.object({ code: z.string() }) as z.ZodType<BrowserEvaluateArgs>,
      handler: browser_evaluate,
    },
    {
      name: "get_environment",
      description: "Get system environment information.",
      inputSchema: z.object({}) as z.ZodType<GetEnvironmentArgs>,
      handler: get_environment,
    },
  ]);

  return registry;
}

export { read_file, write_file, edit_file, search_files, list_directory, create_directory, move_file, get_file_info, read_multiple_files };
export { execute_command, execute_command_stream, list_processes, kill_process };
export { browser_navigate, browser_screenshot, browser_click, browser_evaluate };
export { get_environment };
