/**
 * MCP Streamable HTTP endpoint.
 *
 * Tool *schemas* are imported from `@deckagent/mcp-server/schemas` and used to
 * validate incoming arguments; the JSON Schema advertised in `tools/list`
 * mirrors the SPEC §4 tool definitions. Tool *execution* is delegated to the
 * connected desktop daemon over the WebSocket tunnel — the Worker never runs
 * tools itself.
 *
 * POST /mcp is handled by `createMcpHandler` (Streamable HTTP). GET /mcp is
 * handled manually to return a plain `tools/list` JSON-RPC response, as the
 * SPEC requires.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler } from 'agents/mcp';
import { schemas } from '@deckagent/mcp-server/schemas';

import { getSessionByToken } from './device-registry.js';
import { executeToolOnDevice, getConnectedDeviceIds, TunnelError } from './tunnel.js';
import type { Env } from './types.js';

/** Structural view of a Zod schema — just enough to validate without coupling
 * to the mcp-server package's (v3) Zod types. */
type ZodLike = {
  safeParse(data: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { message: string } };
};

interface WorkerTool {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  schema: ZodLike;
}

type JsonSchema = Tool['inputSchema'];

function objectSchema(properties: Record<string, object>, required: string[] = []): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** All tools exposed over MCP, in a stable order. */
const TOOLS: WorkerTool[] = [
  // ---- Filesystem ----
  {
    name: 'read_file',
    description:
      'Read the complete contents of a file from the local filesystem. Use for any text-based file. For large files, specify offset and limit. If the path is a directory, its contents are listed.',
    schema: schemas.ReadFileArgsSchema,
    inputSchema: objectSchema(
      {
        path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)', default: 1 },
        limit: { type: 'number', description: 'Maximum number of lines to read', default: 500, maximum: 5000 },
      },
      ['path'],
    ),
  },
  {
    name: 'write_file',
    description:
      'Write content to a file, creating it if it does not exist. OVERWRITES existing content. Use edit_file for surgical changes.',
    schema: schemas.WriteFileArgsSchema,
    inputSchema: objectSchema(
      {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      ['path', 'content'],
    ),
  },
  {
    name: 'edit_file',
    description:
      'Surgical find-and-replace edit on a file. Replaces an exact string match, falling back to whitespace-tolerant fuzzy matching. Set replace_all to replace every occurrence.',
    schema: schemas.EditFileArgsSchema,
    inputSchema: objectSchema(
      {
        path: { type: 'string', description: 'Absolute path to the file' },
        old_string: { type: 'string', description: 'Text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences instead of a unique match', default: false },
      },
      ['path', 'old_string', 'new_string'],
    ),
  },
  {
    name: 'search_files',
    description:
      'Search file contents using ripgrep (falls back to a pure-Node scan). Fast regex search across a directory tree.',
    schema: schemas.SearchFilesArgsSchema,
    inputSchema: objectSchema(
      {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in', default: '~' },
        file_glob: { type: 'string', description: "Filter by file pattern (e.g. '*.ts')" },
        max_results: { type: 'number', description: 'Maximum results to return', default: 50, maximum: 200 },
      },
      ['pattern'],
    ),
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path with metadata (type, size, modified time).',
    schema: schemas.ListDirectoryArgsSchema,
    inputSchema: objectSchema(
      { path: { type: 'string', description: 'Absolute path to the directory' } },
      ['path'],
    ),
  },
  {
    name: 'create_directory',
    description: 'Create a directory and all parent directories if they do not exist.',
    schema: schemas.CreateDirectoryArgsSchema,
    inputSchema: objectSchema(
      { path: { type: 'string', description: 'Absolute path of the directory to create' } },
      ['path'],
    ),
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory.',
    schema: schemas.MoveFileArgsSchema,
    inputSchema: objectSchema(
      {
        source: { type: 'string', description: 'Absolute source path' },
        destination: { type: 'string', description: 'Absolute destination path' },
      },
      ['source', 'destination'],
    ),
  },
  {
    name: 'get_file_info',
    description: 'Get metadata about a file or directory: size, timestamps, type, and permissions.',
    schema: schemas.GetFileInfoArgsSchema,
    inputSchema: objectSchema(
      { path: { type: 'string', description: 'Absolute path to the file or directory' } },
      ['path'],
    ),
  },
  {
    name: 'read_multiple_files',
    description: 'Read several files at once. Returns their contents separated by --- markers.',
    schema: schemas.ReadMultipleFilesArgsSchema,
    inputSchema: objectSchema(
      {
        paths: {
          type: 'array',
          description: 'Absolute paths of the files to read',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      ['paths'],
    ),
  },
  // ---- Terminal ----
  {
    name: 'execute_command',
    description:
      'Execute a shell command and return its output. Use for running scripts, builds, tests, and git operations. Timeout defaults to 60s (max 300s).',
    schema: schemas.ExecuteCommandArgsSchema,
    inputSchema: objectSchema(
      {
        command: { type: 'string', description: 'Shell command to execute' },
        workdir: { type: 'string', description: 'Working directory (default: home directory)' },
        timeout: { type: 'number', description: 'Timeout in seconds', default: 60, maximum: 300 },
        env: {
          type: 'object',
          description: 'Additional environment variables',
          additionalProperties: { type: 'string' },
        },
      },
      ['command'],
    ),
  },
  {
    name: 'execute_command_stream',
    description:
      'Execute a command, collecting its output until completion. Intended for long-running commands. In v1 the collected output is returned once the command finishes.',
    schema: schemas.ExecuteCommandStreamArgsSchema,
    inputSchema: objectSchema(
      {
        command: { type: 'string', description: 'Shell command to execute' },
        workdir: { type: 'string', description: 'Working directory (default: home directory)' },
      },
      ['command'],
    ),
  },
  {
    name: 'list_processes',
    description: 'List running processes on the system. Optionally filter by a substring of the process line.',
    schema: schemas.ListProcessesArgsSchema,
    inputSchema: objectSchema({
      filter: { type: 'string', description: "Optional filter (e.g. 'node', 'python')" },
    }),
  },
  {
    name: 'kill_process',
    description: 'Kill a process by PID, optionally with a specific signal (default SIGTERM).',
    schema: schemas.KillProcessArgsSchema,
    inputSchema: objectSchema(
      {
        pid: { type: 'number', description: 'Process ID to kill' },
        signal: { type: 'string', description: 'Signal to send', default: 'SIGTERM' },
      },
      ['pid'],
    ),
  },
  // ---- Browser ----
  {
    name: 'browser_navigate',
    description: 'Open a URL in the browser and return the page title plus a base64 PNG screenshot.',
    schema: schemas.BrowserNavigateArgsSchema,
    inputSchema: objectSchema(
      {
        url: { type: 'string', description: 'URL to navigate to' },
        headless: { type: 'boolean', description: 'Run headless', default: true },
      },
      ['url'],
    ),
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser page and return it as base64 PNG.',
    schema: schemas.BrowserScreenshotArgsSchema,
    inputSchema: objectSchema({
      full_page: { type: 'boolean', description: 'Capture full page', default: false },
    }),
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page identified by a CSS selector.',
    schema: schemas.BrowserClickArgsSchema,
    inputSchema: objectSchema(
      { selector: { type: 'string', description: 'CSS selector for the element' } },
      ['selector'],
    ),
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the current page context and return the result.',
    schema: schemas.BrowserEvaluateArgsSchema,
    inputSchema: objectSchema(
      { code: { type: 'string', description: 'JavaScript code to execute' } },
      ['code'],
    ),
  },
  // ---- Environment ----
  {
    name: 'get_environment',
    description:
      'Get system environment information — OS, architecture, platform, hostname, home directory, shell, CPU count, and memory.',
    schema: schemas.GetEnvironmentArgsSchema,
    inputSchema: objectSchema({}),
  },
];

const TOOL_BY_NAME = new Map<string, WorkerTool>(TOOLS.map((t) => [t.name, t]));

/** MCP tool descriptors advertised in `tools/list`. */
function toolList(): Tool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** Map a SPEC §6.1 string code to the closest JSON-RPC numeric error code. */
function numericCode(code: string): number {
  switch (code) {
    case 'TOOL_NOT_FOUND':
      return ErrorCode.MethodNotFound;
    case 'INVALID_ARGUMENTS':
      return ErrorCode.InvalidParams;
    case 'TOOL_TIMEOUT':
      return ErrorCode.RequestTimeout;
    default:
      return ErrorCode.InternalError;
  }
}

function mcpError(code: string, message: string, data?: unknown): McpError {
  const base = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return new McpError(numericCode(code), message, { code, ...base });
}

/** Build a fresh McpServer per request (required for stateless handlers). */
function buildServer(env: Env, deviceId: string | null): McpServer {
  const mcp = new McpServer({ name: 'DeckAgent', version: '1.0.0' });
  const server = mcp.server;
  server.registerCapabilities({ tools: {} });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOL_BY_NAME.get(request.params.name);
    if (!tool) {
      throw mcpError('TOOL_NOT_FOUND', `Tool not found: ${request.params.name}`);
    }
    const parsed = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      throw mcpError('INVALID_ARGUMENTS', `Invalid arguments for ${tool.name}: ${parsed.error.message}`);
    }
    if (!deviceId) {
      throw mcpError('DEVICE_OFFLINE', 'No desktop daemon is connected');
    }
    try {
      const result = await executeToolOnDevice(deviceId, tool.name, parsed.data);
      return { content: result.content, isError: result.isError };
    } catch (err) {
      if (err instanceof TunnelError) {
        throw mcpError(err.code, err.message, err.data);
      }
      throw mcpError('INTERNAL_ERROR', err instanceof Error ? err.message : 'Tool execution failed');
    }
  });

  return mcp;
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
}

function jsonRpcError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Resolve the device this request should target (single-tenant v1). */
function resolveDeviceId(deviceIdFromSession: string | null): string | null {
  if (deviceIdFromSession) return deviceIdFromSession;
  return getConnectedDeviceIds()[0] ?? null;
}

/** Entry point for `GET/POST /mcp`. */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = extractBearer(request);
  const session = token ? await getSessionByToken(env, token) : null;
  if (!token || !session) {
    return jsonRpcError(401, 'UNAUTHORIZED', 'Missing or invalid access token');
  }

  const deviceId = resolveDeviceId(session.device_id);

  if (request.method === 'GET') {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, result: { tools: toolList() } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const server = buildServer(env, deviceId);
  const handler = createMcpHandler(server, { route: '/mcp' });
  return handler(request, env, ctx);
}
