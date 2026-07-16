/**
 * Single source of truth for the MCP tool catalog exposed by the Worker.
 * Must stay in sync with @deckagent/mcp-server tools plus Worker-local tools.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_CATALOG: McpToolDefinition[] = [
  {
    name: "list_devices",
    description:
      "List registered DeckAgent devices and their online/offline status. Worker-local; does not require a desktop daemon round-trip.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description:
      "Read the complete contents of a file from the local filesystem. Use for any text-based file. For large files, specify offset and limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        offset: {
          type: "number",
          description: "Line number to start from (1-indexed)",
          default: 1,
        },
        limit: {
          type: "number",
          description: "Maximum lines to read",
          default: 500,
          maximum: 5000,
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file, creating it if it doesn't exist. OVERWRITES existing content. Use edit_file for surgical changes.",
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
    description: "Surgical find-and-replace edit on a file. Replaces exact string match.",
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
    description:
      "Search file contents using ripgrep. Fast regex search across your project.",
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
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "create_directory",
    description:
      "Create a directory and all parent directories if they don't exist.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_multiple_files",
    description: "Read up to 10 files in one call.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
    },
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
        use_secrets: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional vault secret names to inject into the child env (explicit; none by default)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "execute_command_stream",
    description: "Execute a command and stream output back in real-time.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
        use_secrets: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional vault secret names to inject into the child env (explicit; none by default)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "list_processes",
    description: "List running processes on the system.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string" } },
    },
  },
  {
    name: "kill_process",
    description: "Kill a process by PID. Requires confirmation by default.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number" },
        signal: { type: "string", default: "SIGTERM" },
      },
      required: ["pid"],
    },
  },
  {
    name: "start_job",
    description:
      "Start a tracked background shell job and return immediately with a job id. Requires confirmation by default.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: {
          type: "string",
          description: "Optional working directory for the job",
        },
        timeout_ms: {
          type: "number",
          default: 1800000,
          maximum: 1800000,
          description: "Maximum runtime in milliseconds (default/cap 30 minutes)",
        },
        env: { type: "object", additionalProperties: { type: "string" } },
        use_secrets: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional vault secret names to inject into the child env (explicit; none by default)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "list_jobs",
    description: "List tracked background jobs, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "completed", "failed", "cancelled", "timed_out"],
        },
      },
    },
  },
  {
    name: "get_job",
    description: "Get background job status and tail stdout/stderr logs.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id returned by start_job" },
        tail_lines: {
          type: "number",
          default: 200,
          maximum: 5000,
          description: "Number of stdout/stderr tail lines to return",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "cancel_job",
    description:
      "Cancel a running background job with SIGTERM, followed by SIGKILL if needed. Requires confirmation by default.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id returned by start_job" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "browser_navigate",
    description:
      "Open a URL in the browser. Requires browser automation to be enabled.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        headless: { type: "boolean", default: true },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current browser page.",
    inputSchema: {
      type: "object",
      properties: { full_page: { type: "boolean", default: false } },
    },
  },
  {
    name: "browser_click",
    description: "Click an element on the page by selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "browser_evaluate",
    description: "Run JavaScript code in the browser page context.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "get_environment",
    description: "Get system environment information.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_snapshots",
    description:
      "List recent file snapshots (pre-edit backups) for undo. Optionally filter by path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional absolute path to filter snapshots",
        },
        limit: {
          type: "number",
          description: "Maximum snapshots to return",
          default: 20,
          maximum: 100,
        },
      },
    },
  },
  {
    name: "restore_snapshot",
    description:
      "Restore a file from a snapshot by id. Mutating — may require confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Snapshot id from list_snapshots" },
      },
      required: ["id"],
    },
  },
];

export const TOOL_NAMES = new Set(TOOL_CATALOG.map((t) => t.name));
export const WORKER_LOCAL_TOOL_NAMES = new Set(["list_devices"]);

export function getToolByName(name: string): McpToolDefinition | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

/**
 * Filter TOOL_CATALOG to the daemon-enabled set (S2).
 * `null` / `undefined` → full catalog (backward compat until first policy_caps).
 */
export function filterToolCatalog(
  enabledTools: ReadonlySet<string> | readonly string[] | null | undefined
): McpToolDefinition[] {
  if (enabledTools == null) {
    return TOOL_CATALOG;
  }
  const set =
    enabledTools instanceof Set
      ? enabledTools
      : new Set(enabledTools);
  return TOOL_CATALOG.filter(
    (t) => set.has(t.name) || WORKER_LOCAL_TOOL_NAMES.has(t.name)
  );
}
