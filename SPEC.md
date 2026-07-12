# DeckAgent SPEC v1 — EXECUTION BLUEPRINT

> Self-hosted MCP bridge. Gives web AI (ChatGPT, Claude, Gemini) hands on your computer.
> **No third-party relay. No paid subscription. Your Worker. Your domain. Your data.**

---

## 0. NON-NEGOTIABLE RULES FOR DEVIN

1. BUILD IN THIS ORDER: mcp-server → cloudflare-worker → desktop-daemon → cli. Never skip ahead.
2. EVERY tool must have Zod schema validation. No `any` types. No `as unknown` casts.
3. ERROR MESSAGES must be human-readable. "File not found: /path/to/file" not "ENOENT".
4. POLICY ENFORCEMENT happens in the daemon, not the Worker. The Worker is stateless.
5. WEB SOCKET tunnel uses JSON-line-delimited messages. One JSON object per line, terminated by `\n`.
6. OAUTH uses GitHub PKCE flow. No exceptions. No bearer tokens in URLs.
7. ALL config is in `~/.deckagent/config.json`. No env vars, no hardcoded paths.
8. DAEMON runs as a user-space process. No sudo, no root, no systemd for v1.
9. LOG everything to `~/.deckagent/logs/`. Rotate at 10MB. Keep last 5 files.
10. TEST every tool with a smoke test before declaring it done. No untested code.

---

## 1. ARCHITECTURE (RECAP)

```
ChatGPT Web / Claude Web / Gemini Web (MCP client)
    |
    HTTPS POST /mcp  (Streamable HTTP transport)
    Authorization: Bearer <access_token>
    |
[Cloudflare Worker] — you deploy this to your CF account
    |  \
    |   GitHub OAuth (PKCE) at /auth/github, /auth/callback
    |
    WebSocket wss://worker.you.workers.dev/tunnel
    JSON-line-delimited messages
    |
[Desktop Daemon] — system tray app on user's machine
    |
    Executes tools locally via @modelcontextprotocol/sdk
    |
    [Filesystem Tools]  [Terminal Tools]  [Browser Tools]
```

---

## 2. CLOUDFLARE WORKER SPEC

### 2.1 Stack
- Runtime: Cloudflare Workers (ES modules format)
- Framework: `@cloudflare/agents` with `createMcpHandler()` (stateless, no Durable Objects needed for v1)
- Language: TypeScript
- Storage: KV for device registry + OAuth state
- Deploy: `wrangler deploy`

### 2.2 wrangler.jsonc

```jsonc
{
  "name": "deckagent",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "kv_namespaces": [
    { "binding": "DECK_KV", "id": "" }  // user fills in after `wrangler kv namespace create`
  ],
  "vars": {
    "GITHUB_CLIENT_ID": "",
    "APP_NAME": "DeckAgent"
  },
  "secrets": {
    "GITHUB_CLIENT_SECRET": "",
    "COOKIE_ENCRYPTION_KEY": ""
  }
}
```

### 2.3 OAuth Flow (GitHub PKCE)

**Step-by-step:**

1. User clicks "Add custom connector" in ChatGPT
2. ChatGPT redirects to `https://worker.you.workers.dev/auth/github?redirect_uri=chatgpt-redirect-uri`
3. Worker generates PKCE challenge + random state, stores in KV (key: `oauth:state:{state}`, value: `{redirect_uri, code_verifier}`, TTL: 10min)
4. Worker redirects user to GitHub OAuth authorize URL
5. User approves on GitHub, GitHub redirects to `https://worker.you.workers.dev/auth/callback?code=xxx&state=yyy`
6. Worker exchanges code for token, stores session in KV (key: `session:{user_id}`, value: `{access_token, user_info}`, TTL: 24h)
7. Worker redirects back to ChatGPT's redirect_uri with access_token
8. ChatGPT calls `POST /mcp` with `Authorization: Bearer <access_token>`

**KV Schema:**

```
oauth:state:{state} = JSON.stringify({
  redirect_uri: string,
  code_verifier: string,
  created_at: number
})  TTL: 600s

session:{user_id} = JSON.stringify({
  github_username: string,
  avatar_url: string,
  device_id: string | null,  // set when daemon connects
  created_at: number
})  TTL: 86400s

device:{device_id} = JSON.stringify({
  name: string,
  status: "online" | "offline",
  ip: string,
  last_seen: number,
  capabilities: string[]  // e.g. ["filesystem", "terminal", "browser"]
})  TTL: 0 (no expiry)
```

### 2.4 MCP Transport

Use **Streamable HTTP transport** (MCP spec standard, supported by both ChatGPT and Claude custom connectors).

**POST /mcp — Tool call:**

Request:
```http
POST /mcp
Content-Type: application/json
Authorization: Bearer <access_token>

{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": {
      "path": "/home/user/project/src/index.ts"
    }
  }
}
```

Response (immediate — tool call forwarded via WebSocket to daemon):
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "// file contents here..."
      }
    ]
  }
}
```

**GET /mcp — Tools list:**
```http
GET /mcp
Authorization: Bearer <access_token>
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "tools": [
      {
        "name": "read_file",
        "description": "Read file contents from the local filesystem",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Absolute path to the file" }
          },
          "required": ["path"]
        }
      }
    ]
  }
}
```

### 2.5 WebSocket Tunnel Protocol

**Connection:**
1. Daemon connects: `wss://worker.you.workers.dev/tunnel`
2. Daemon sends auth message: `{"type":"auth","device_id":"xxx","token":"yyy"}\n`
3. Worker validates, responds: `{"type":"auth_ok","session_id":"zzz"}\n` or `{"type":"auth_error","reason":"..."}\n`
4. If auth_ok, Worker updates KV: `device:{device_id}.status = "online"`

**Message format (all JSON, newline-delimited):**

```jsonc
// Worker -> Daemon: Execute a tool
{"type":"execute_tool","id":"1","tool":"read_file","args":{"path":"..."}}

// Daemon -> Worker: Tool result
{"type":"tool_result","id":"1","result":{"content":[{"type":"text","text":"..."}]}}

// Daemon -> Worker: Tool error
{"type":"tool_error","id":"1","error":{"code":"FILE_NOT_FOUND","message":"File not found"}}

// Daemon -> Worker: Heartbeat
{"type":"heartbeat","timestamp":1712345678}

// Worker -> Daemon: Heartbeat ack
{"type":"heartbeat_ack"}

// Daemon -> Worker: State update (tool list changed, capabilities changed)
{"type":"state_update","capabilities":["filesystem","terminal","browser"]}
```

**Timeout handling:**
- Tool execution timeout: 60 seconds
- If daemon doesn't respond within 60s, Worker returns error to ChatGPT
- Heartbeat interval: 15 seconds
- If no heartbeat for 45 seconds, Worker marks device offline, stops forwarding tool calls
- Worker queues up to 5 tool calls while daemon reconnects, then starts returning errors

### 2.6 Device Registry

When daemon authenticates, Worker checks `device:{device_id}` in KV.
- If exists and token matches: accept
- If exists and token doesn't match: reject
- If doesn't exist: reject (device must be registered via CLI first)

Device registration happens during `deckagent setup`:
1. CLI generates device_id + random token
2. Writes to `~/.deckagent/config.json`
3. Calls Worker API (authenticated with deploy token): `POST /api/devices`
4. Worker stores `device:{device_id}` in KV

**Registration API:** (protected by deploy-time secret, not OAuth)

```http
POST /api/devices
Content-Type: application/json
Authorization: Bearer <deploy_secret>

{
  "device_id": "uuid",
  "name": "My MacBook",
  "token": "random-256-bit-hex",
  "capabilities": ["filesystem", "terminal", "browser"]
}
```

---

## 3. DESKTOP DAEMON SPEC

### 3.1 Stack
- Runtime: Node.js 18+ (or Go for smaller binary — decision: start with Node.js, port to Go if needed)
- Framework: `@modelcontextprotocol/sdk` for tool definitions
- WebSocket: `ws` library
- Process management: `child_process` with PTY support via `node-pty` (optional)
- Install: npm global (`deckagent daemon`) or bundled binary

### 3.2 Directory Layout

```
~/.deckagent/
├── config.json              # Device ID, token, worker URL, user preferences
├── policy.json              # Security policy (allowed dirs, blocked commands)
├── deckagent.log            # Current log
├── logs/
│   ├── deckagent-2026-07-12.log
│   └── deckagent-2026-07-11.log  # rotated at 10MB, keep 5
└── daemon.pid               # PID file for lifecycle management
```

### 3.3 config.json

```json
{
  "device_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "token": "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe",
  "worker_url": "https://deckagent.your-name.workers.dev",
  "device_name": "My MacBook Pro",
  "heartbeat_interval": 15,
  "tool_timeout": 60,
  "auto_connect": true,
  "log_level": "info"
}
```

### 3.4 Lifecycle

```
START
  ├─ Read config (~/.deckagent/config.json)
  ├─ Load policy (~/.deckagent/policy.json)
  ├─ Validate config (device_id, token, worker_url all present)
  ├─ Write PID file
  ├─ Connect WebSocket to worker_url/tunnel
  │   ├─ On success: send auth message, start heartbeat timer
  │   └─ On failure: retry with exponential backoff (1s, 2s, 4s, 8s, 16s, max 60s)
  ├─ Event loop:
  │   ├─ Receive message from WS
  │   │   ├─ type: "execute_tool" -> validate with policy -> execute -> send response
  │   │   └─ type: "heartbeat_ack" -> update last_heartbeat_ack timestamp
  │   ├─ Every 15s: send heartbeat
  │   ├─ Every 60s: check last_heartbeat_ack, if stale > 60s, reconnect
  │   └─ On WS close: reconnect with exponential backoff
  ├─ On SIGTERM/SIGINT:
  │   ├─ Send disconnect message
  │   ├─ Close WebSocket
  │   ├─ Kill active tool processes
  │   └─ Exit with code 0
  └─ On crash:
      └─ Write crash log to ~/.deckagent/crash-{timestamp}.log
```

### 3.5 Tool Executor

The daemon imports tool implementations from `@deckagent/mcp-server` and calls them when the Worker forwards a request.

```typescript
interface ToolRequest {
  type: 'execute_tool';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ToolResult {
  type: 'tool_result';
  id: string;
  result: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

interface ToolError {
  type: 'tool_error';
  id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

**Execution pipeline:**
1. Receive `execute_tool` message
2. Check if tool name is in allowed list
3. Check policy: is `path` arg within `allowed_directories`? Is this a blocked command?
4. If tool requires confirmation and no cached approval: send `confirmation_request` message, wait for user

   **Confirmation flow (for destructive operations):**
   ```
   Daemon -> Worker: {"type":"confirmation_required","id":"1","tool":"write_file","args":{"path":"/etc/passwd"},"reason":"Writing to system directory"}
   Worker -> ChatGPT: error response with confirmation_required
   ChatGPT -> User: "DeckAgent needs to write to /etc/passwd. Allow?"
   User -> ChatGPT: "Yes"
   ChatGPT -> Worker: retry with _confirm=true
   Worker -> Daemon: execute_tool with _preconfirmed:true
   Daemon: executes tool
   ```
   (For v1, the confirmation_required field is returned as a tool error and the AI can retry with `_confirm: true`)

5. If confirmation not needed: execute tool immediately via the tool registry
6. Send `tool_result` or `tool_error` back

### 3.6 Policy Engine

```typescript
interface Policy {
  version: number;  // increment on changes, default 1
  allowed_directories: string[];  // paths the AI can read/write, supports ~ expansion
  blocked_commands: string[];     // shell commands that are blocked (substring match)
  require_confirmation: string[]; // tool names that need user approval
  read_only: boolean;             // if true, no write/mutate tools allowed
  allow_browser: boolean;         // if false, browser tools return "disabled by policy"
  allow_terminal: boolean;        // if false, terminal tools return "disabled by policy"
  allow_computer_use: boolean;    // reserved for v2
  max_file_read_size: number;     // bytes, default 10MB
  max_command_timeout: number;    // seconds, default 300
}
```

**Policy validation:**
- Paths in `allowed_directories` are resolved to absolute paths on load
- Symlinks are resolved before comparing (security: prevent symlink escapes)
- `blocked_commands` uses substring matching on the command string (lowercased)
- `require_confirmation` is checked before every tool call

---

## 4. MCP TOOLS SPEC

### 4.1 Filesystem Tools

#### read_file
```typescript
{
  name: "read_file",
  description: "Read the complete contents of a file from the local filesystem. Use for any text-based file. For large files, specify offset and limit.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed, default: 1)", default: 1 },
      limit: { type: "number", description: "Maximum number of lines to read (default: 500, max: 5000)", default: 500, maximum: 5000 }
    },
    required: ["path"]
  }
}
```
Implementation:
- Resolve path (expand `~`)
- Check `allowed_directories`
- Check file size <= `max_file_read_size`
- Read file with `fs.createReadStream` or line-by-line
- Return `{ content: [{ type: "text", text: "<content>" }] }`
- If file is binary (>30% null bytes), return error: "File appears to be binary"

#### write_file
```typescript
{
  name: "write_file",
  description: "Write content to a file, creating it if it doesn't exist. OVERWRITES existing content. Use edit_file for surgical changes.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Content to write to the file" }
    },
    required: ["path", "content"]
  }
}
```
Implementation:
- Create parent directories if they don't exist (`fs.mkdirSync` with recursive)
- Write file atomically: write to `.tmp` then rename
- Return `{ content: [{ type: "text", text: "Written X bytes to /path/to/file" }] }`

#### edit_file
```typescript
{
  name: "edit_file",
  description: "Surgical find-and-replace edit on a file. Replaces exact string match. Uses fuzzy matching for minor whitespace differences.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      old_string: { type: "string", description: "Text to find and replace. Must be unique in the file unless replace_all is true." },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences instead of requiring unique match", default: false }
    },
    required: ["path", "old_string", "new_string"]
  }
}
```
Implementation:
- Read file content
- If `replace_all`: replace all occurrences of `old_string` with `new_string`
- If not `replace_all`: find unique match, replace
- If multiple matches and not `replace_all`: return error "Found X occurrences. Use replace_all=true or provide more context."
- Write back to file
- Return `{ content: [{ type: "text", text: "Diff:\n- old line\n+ new line" }] }`

#### search_files
```typescript
{
  name: "search_files",
  description: "Search file contents using ripgrep. Fast regex search across your project.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory to search in (default: allowed directories)", default: "~" },
      file_glob: { type: "string", description: "Filter by file pattern (e.g. '*.ts', '*.py')" },
      max_results: { type: "number", description: "Maximum results to return", default: 50, maximum: 200 }
    },
    required: ["pattern"]
  }
}
```
Implementation:
- Shell out to `rg` (ripgrep) with `-n --color never --max-count 10`
- Parse output
- Return `{ content: [{ type: "text", text: "path/to/file.ts:42: matching line" }] }`
- If rg not installed: fall back to Node.js `fs.readFile` + regex (slower)

#### list_directory
```typescript
{
  name: "list_directory",
  description: "List files and directories in a path with metadata.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the directory" }
    },
    required: ["path"]
  }
}
```

#### create_directory
```typescript
{
  name: "create_directory",
  description: "Create a directory and all parent directories if they don't exist.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the directory to create" }
    },
    required: ["path"]
  }
}
```

#### move_file
```typescript
{
  name: "move_file",
  description: "Move or rename a file or directory.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Absolute source path" },
      destination: { type: "string", description: "Absolute destination path" }
    },
    required: ["source", "destination"]
  }
}
```

### 4.2 Terminal Tools

#### execute_command
```typescript
{
  name: "execute_command",
  description: "Execute a shell command and return its output. Use for running scripts, builds, tests, git operations. Timeout is 300 seconds.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      workdir: { type: "string", description: "Working directory (default: home directory)" },
      timeout: { type: "number", description: "Timeout in seconds (max: 300)", default: 60, maximum: 300 },
      env: { type: "object", description: "Additional environment variables", additionalProperties: { type: "string" } }
    },
    required: ["command"]
  }
}
```
Implementation:
- Check command against `blocked_commands` (substring match, lowercase)
- Spawn `child_process.exec` with timeout
- Return `{ content: [{ type: "text", text: "stdout" }, { type: "text", text: "stderr" }] }`
- If exit code !== 0: `{ content: [...], isError: true }`
- If timeout: return error "Command timed out after X seconds"

#### execute_command_stream
```typescript
{
  name: "execute_command_stream",
  description: "Execute a command and stream output back in real-time. Use for long-running commands where you want to see progress.",
  inputSchema: {
    name: "execute_command_stream",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" }
      },
      required: ["command"]
    }
  }
}
```
Implementation:
- This tool works differently — it returns immediately and the daemon streams output via WebSocket
- Message flow:
  ```
  ChatGPT -> Worker -> Daemon: execute_command_stream
  Daemon: spawns process
  Daemon -> Worker -> ChatGPT: {"type":"text","text":"Compiling..."}
  Daemon -> Worker -> ChatGPT: {"type":"text","text":"Build successful!"}
  Daemon -> Worker -> ChatGPT: {result, isError: false}
  ```
- For ChatGPT MCP, this is delivered as SSE events

#### list_processes
```typescript
{
  name: "list_processes",
  description: "List running processes on the system.",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Optional filter (e.g. 'node', 'python')" }
    }
  }
}
```
Implementation:
- Call `ps aux` (or OS-specific API)
- Parse output
- Return as structured text

#### kill_process
```typescript
{
  name: "kill_process",
  description: "Kill a process by PID. Requires confirmation by default.",
  inputSchema: {
    type: "object",
    properties: {
      pid: { type: "number", description: "Process ID to kill" },
      signal: { type: "string", description: "Signal to send (default: SIGTERM)", default: "SIGTERM" }
    },
    required: ["pid"]
  }
}
```

### 4.3 Browser Tools (v1 — simple, v2 — full Playwright)

#### browser_navigate
```typescript
{
  name: "browser_navigate",
  description: "Open a URL in the browser. Requires browser automation to be enabled in policy.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to navigate to" },
      headless: { type: "boolean", description: "Run headless (default: true)", default: true }
    },
    required: ["url"]
  }
}
```
Implementation:
- Check `policy.allow_browser`
- Launch Playwright (Chromium)
- Navigate to URL
- Wait for page load
- Return screenshot + page title

#### browser_screenshot
```typescript
{
  name: "browser_screenshot",
  description: "Take a screenshot of the current browser page.",
  inputSchema: {
    type: "object",
    properties: {
      full_page: { type: "boolean", description: "Capture full page (default: false)", default: false }
    }
  }
}
```

#### browser_click
```typescript
{
  name: "browser_click",
  description: "Click an element on the page by selector.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector for the element" }
    },
    required: ["selector"]
  }
}
```

#### browser_evaluate
```typescript
{
  name: "browser_evaluate",
  description: "Run JavaScript code in the browser page context.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "JavaScript code to execute" }
    },
    required: ["code"]
  }
}
```

### 4.4 Environment Tools

#### get_environment
```typescript
{
  name: "get_environment",
  description: "Get system environment information — OS, architecture, platform, home directory, hostname.",
  inputSchema: { type: "object", properties: {} }
}
```
Returns:
```json
{
  "os": "darwin",
  "arch": "arm64",
  "platform": "macOS 15.2",
  "hostname": "my-macbook",
  "home_dir": "/Users/me",
  "shell": "/bin/zsh",
  "cpu_count": 10,
  "memory_gb": 16
}
```

---

## 5. CLI INSTALLER SPEC

### 5.1 Entry Point

```
npx deckagent setup
```

### 5.2 Setup Flow

```
1. Check prerequisites:
   - Node.js >= 18
   - npm installed
   - Git installed
   - wrangler installed (or install it)
   - Cloudflare account (prompt user to create one if not)

2. Cloudflare Worker setup:
   - Log in: npx wrangler login
   - Create KV namespace: npx wrangler kv namespace create "DECK_KV"
   - Write wrangler.jsonc with KV binding ID
   - Ask for GitHub OAuth App credentials
     - Guide user to create GitHub OAuth App:
       - Homepage URL: https://github.com
       - Callback URL: https://deckagent.{username}.workers.dev/auth/callback
   - Set secrets: npx wrangler secret put GITHUB_CLIENT_SECRET
   - Generate COOKIE_ENCRYPTION_KEY: openssl rand -hex 32
   - Deploy: npx wrangler deploy
   - Save deployed URL

3. Generate device identity:
   - device_id = crypto.randomUUID()
   - token = crypto.randomBytes(32).toString('hex')
   - Register device: POST {worker_url}/api/devices with deploy_secret

4. Write config files:
   - ~/.deckagent/config.json (device_id, token, worker_url)
   - ~/.deckagent/policy.json (default policy)

5. Install daemon as background service:
   - macOS: create LaunchAgent plist in ~/Library/LaunchAgents/
   - Linux: create systemd user service in ~/.config/systemd/user/
   - Windows: create scheduled task or registry Run key

6. Start daemon:
   - Launch deckagent daemon process
   - Verify WebSocket connection succeeds
   - Print: "DeckAgent is running! Connect your AI at:"
   - Print: "https://deckagent.{username}.workers.dev/mcp"

7. Print instructions:
   - "In ChatGPT: Settings → Custom Connectors → Add → enter the URL above"
   - "In Claude: Settings → Custom Connectors → Add → enter the URL above"
```

### 5.3 Commands

| Command | Description |
|---|---|
| `deckagent setup` | Full setup (steps 1-7 above) |
| `deckagent daemon` | Start the daemon (run as background service) |
| `deckagent daemon --foreground` | Start in foreground (for testing) |
| `deckagent daemon --stop` | Stop the daemon |
| `deckagent status` | Check if daemon is running and connected |
| `deckagent logs` | Tail the daemon log |
| `deckagent update` | Pull latest Worker code, redeploy |
| `deckagent uninstall` | Stop daemon, remove config, remove LaunchAgent |

---

## 6. ERROR HANDLING

### 6.1 Error Codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid access token |
| `OAUTH_REQUIRED` | 401 | User needs to authenticate via OAuth |
| `TOOL_NOT_FOUND` | 404 | Tool name doesn't exist |
| `INVALID_ARGUMENTS` | 400 | Tool arguments failed Zod validation |
| `DEVICE_OFFLINE` | 503 | Desktop daemon is not connected |
| `TOOL_TIMEOUT` | 504 | Tool execution exceeded timeout |
| `POLICY_BLOCKED` | 403 | Policy prevented execution |
| `CONFIRMATION_REQUIRED` | 403 | Tool requires user confirmation |
| `FILE_NOT_FOUND` | 404 | File doesn't exist |
| `FILE_TOO_LARGE` | 413 | File exceeds max_file_read_size |
| `COMMAND_BLOCKED` | 403 | Command matched blocked_commands list |
| `INTERNAL_ERROR` | 500 | Unexpected error (log crash) |

### 6.2 Error Response Format

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": {
    "code": "TOOL_TIMEOUT",
    "message": "Tool 'execute_command' timed out after 300 seconds",
    "data": {
      "tool": "execute_command",
      "command": "npm run build",
      "timeout": 300,
      "partial_output": "Compiling...\n"
    }
  }
}
```

---

## 7. SECURITY

### 7.1 Threat Model
- **Attacker gains access to ChatGPT account** -> can call DeckAgent tools
  - Mitigation: OAuth is separate from ChatGPT auth. Device token is required.
  - Mitigation: Policy limits what tools can do (read-only mode, blocked directories)
- **Attacker intercepts network traffic** -> sees tool calls and results
  - Mitigation: All traffic is HTTPS/WSS. CF Worker enforces TLS.
- **Agent goes rogue (prompt injection)** -> tries to run dangerous commands
  - Mitigation: `blocked_commands` list (rm -rf, sudo, etc.)
  - Mitigation: `require_confirmation` list
  - Mitigation: `read_only` mode
- **Daemon is compromised** -> attacker has local machine access
  - Daemon runs as user, not root
  - No open ports (outbound-only)
  - All code is open source (auditable)

### 7.2 Deploy Secret
During `deckagent setup`, the CLI generates a deploy secret and stores it locally. This is used to:
- Register the device with the Worker
- Update capabilities
- The deploy secret should be rotated after initial setup

---

## 8. FILE STRUCTURE (FINAL)

```
deckagent/
├── SPEC.md                         ← THIS FILE
├── AGENTS.md                        ← Devin build instructions
├── README.md                        ← Public README
├── LICENSE                          ← MIT
├── packages/
│   ├── cloudflare-worker/
│   │   ├── src/
│   │   │   ├── index.ts             ← Entry: POST/GET /mcp, /auth/*, /api/*
│   │   │   ├── auth.ts             ← GitHub OAuth PKCE
│   │   │   ├── tunnel.ts           ← WebSocket tunnel management
│   │   │   ├── mcp-handler.ts      ← MCP JSON-RPC processing + forwarding
│   │   │   ├── device-registry.ts  ← KV operations for devices
│   │   │   └── types.ts            ← Shared types for Worker
│   │   ├── wrangler.jsonc
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── desktop-daemon/
│   │   ├── src/
│   │   │   ├── index.ts            ← Entry: lifecycle, signal handling
│   │   │   ├── tunnel-client.ts    ← WebSocket client
│   │   │   ├── tool-executor.ts    ← Receives requests, calls tools
│   │   │   ├── policy.ts           ← Policy validation
│   │   │   ├── config.ts           ← Config read/write
│   │   │   └── logger.ts           ← Logging + rotation
│   │   └── package.json
│   ├── mcp-server/
│   │   ├── src/
│   │   │   ├── index.ts            ← Tool registry + exports
│   │   │   ├── tools/filesystem.ts ← File tools
│   │   │   ├── tools/terminal.ts   ← Terminal tools
│   │   │   ├── tools/browser.ts    ← Browser tools
│   │   │   ├── tools/environment.ts← Env info tools
│   │   │   └── schemas.ts          ← All Zod schemas
│   │   └── package.json
│   └── cli/
│       ├── src/
│       │   ├── index.ts            ← CLI entry point (commander or cliffy)
│       │   ├── setup.ts            ← Full setup flow
│       │   ├── deploy-worker.ts    ← wrangler deploy automation
│       │   ├── install-daemon.ts   ← LaunchAgent/systemd/service creation
│       │   └── configure.ts        ← Config generation
│       └── package.json
└── reference/
    └── desktop-commander/           ← For reference (MIT license)
```

---

## 9. BUILD ORDER (LOCKED — DO NOT CHANGE)

| Step | Package | What to build | Depends on |
|---|---|---|---|
| 1 | `mcp-server` | All tool implementations + Zod schemas | Nothing |
| 2 | `cloudflare-worker` | MCP handler, OAuth, tunnel, device registry, KV | Step 1 (types) |
| 3 | `desktop-daemon` | WebSocket client, tool executor, policy, lifecycle | Step 1 (tools) |
| 4 | `cli` | Setup flow, deploy, install, configure | Steps 2+3 |

### Step 1 Details: mcp-server

Build ALL the tool functions + their Zod schemas. Export a `ToolRegistry` class:

```typescript
class ToolRegistry {
  register(tool: ToolDefinition): void
  registerAll(tools: ToolDefinition[]): void
  get(name: string): ToolDefinition | undefined
  list(): ToolDefinition[]
  execute(name: string, args: unknown): Promise<ToolResponse>
}
```

Each tool implementation is a pure async function: `(args: T) => Promise<ToolResponse>`. No side effects, no global state. Testable in isolation.

### Step 2 Details: cloudflare-worker

Build in this order:
1. `types.ts` — All TypeScript interfaces
2. `auth.ts` — OAuth PKCE flow + KV session management
3. `device-registry.ts` — KV CRUD for devices
4. `tunnel.ts` — WebSocket connection management, message routing
5. `mcp-handler.ts` — Parses MCP JSON-RPC, routes to tool calls via tunnel
6. `index.ts` — Router: `/mcp`, `/auth/*`, `/api/*`, `/tunnel`, `/health`

### Step 3 Details: desktop-daemon

Build in this order:
1. `config.ts` — Read/write ~/.deckagent/config.json
2. `logger.ts` — File logger with rotation
3. `policy.ts` — Load and validate policy.json
4. `tunnel-client.ts` — WebSocket client with reconnection
5. `tool-executor.ts` — Receives execute_tool, validates with policy, runs via mcp-server
6. `index.ts` — Main loop, signal handling, lifecycle

### Step 4 Details: cli

Build in this order:
1. `configure.ts` — Generate config.json and policy.json
2. `deploy-worker.ts` — Automate wrangler deployment
3. `install-daemon.ts` — Create LaunchAgent/systemd service
4. `setup.ts` — Orchestrate the full flow
5. `index.ts` — CLI command definitions

---

## 10. TESTING

```
packages/mcp-server/   -> npm test    # Unit tests for every tool
packages/desktop-daemon/ -> npm test  # Unit tests for policy, config, tool-executor
```

v1 testing is manual (CLI-based). The spec is the test.

---

## EXECUTION

Every line of this spec is buildable. Nothing here requires research or experimentation. Every pattern (CF Workers, WebSocket, OAuth, MCP, fs ops, child_process) is well-documented and widely used.

Build it.
