// MCP tool list shared with the Durable Object tunnel handler.
export const tools = [
  {
    name: "read_file",
    description: "Read the complete contents of a file from the local filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start from (1-indexed)", default: 1 },
        limit: { type: "number", description: "Maximum lines to read", default: 500, maximum: 5000 },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it if needed. OVERWRITES existing content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Surgical find-and-replace edit on a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "search_files",
    description: "Search file contents using ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", default: "~" },
        file_glob: { type: "string" },
        max_results: { type: "number", default: 50, maximum: 200 },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories in a path with metadata.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "create_directory",
    description: "Create a directory and all parent directories.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read_multiple_files",
    description: "Read up to 10 files in one call.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
  },
  {
    name: "execute_command",
    description: "Execute a shell command and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
        timeout: { type: "number", default: 60, maximum: 300 },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["command"],
    },
  },
  {
    name: "execute_command_stream",
    description: "Execute a command and stream output back in real-time.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
  },
  {
    name: "list_processes",
    description: "List running processes on the system.",
    inputSchema: { type: "object", properties: { filter: { type: "string" } } },
  },
  {
    name: "kill_process",
    description: "Kill a process by PID. Requires confirmation by default.",
    inputSchema: { type: "object", properties: { pid: { type: "number" }, signal: { type: "string", default: "SIGTERM" } }, required: ["pid"] },
  },
  {
    name: "browser_navigate",
    description: "Open a URL in the browser.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, headless: { type: "boolean", default: true } }, required: ["url"] },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current browser page.",
    inputSchema: { type: "object", properties: { full_page: { type: "boolean", default: false } } },
  },
  {
    name: "browser_click",
    description: "Click an element on the page by selector.",
    inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  },
  {
    name: "browser_evaluate",
    description: "Run JavaScript code in the browser page context.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "get_environment",
    description: "Get system environment information.",
    inputSchema: { type: "object", properties: {} },
  },
];
