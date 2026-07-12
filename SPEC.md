# DeckAgent SPEC v1

> Self-hosted MCP bridge that gives web AI (ChatGPT, Claude, Gemini) hands on your computer.

---

## 1. Why This Exists

ChatGPT/Claude web can now connect to custom MCP servers via HTTPS (custom connectors). But existing solutions force you through a third-party relay (Desktop Commander uses Supabase). DeckAgent lets you **deploy your own Cloudflare Worker** that tunnels to a desktop daemon on your machine -- fully self-hosted, no middleman, your domain, your auth.

## 2. Architecture

```
ChatGPT Web / Claude Web / Gemini Web
         |
    HTTPS + OAuth 2.1
         |
[Cloudflare Worker]  <-- you deploy this
         |
    WebSocket tunnel (outbound from desktop)
         |
[Desktop Daemon]  <-- system tray app on your machine
         |
    [MCP Tools]
    - Filesystem (read, write, search, edit)
    - Terminal (execute, manage processes)
    - Browser automation (Playwright)
    - Computer-use (future: screen, mouse, keyboard)
```

### Key design decisions

| Decision | Why |
|---|---|
| **CF Worker as public endpoint** | Free tier, global edge, your domain, OAuth built-in |
| **Outbound tunnel from desktop** | No open ports on user's machine, no NAT/firewall issues |
| **Desktop daemon as tray app** | Lifecycle management (sleep, reconnect, permissions) |
| **OAuth via GitHub** | ChatGPT's custom connector requires OAuth |
| **Streamable HTTP transport** | Modern MCP standard, supported by ChatGPT + Claude |

## 3. System Components

### 3.1 Cloudflare Worker (`packages/cloudflare-worker/`)

The public MCP endpoint. Handles:

- **MCP JSON-RPC over Streamable HTTP** (POST /mcp, GET /mcp/sse)
- **OAuth 2.1** with GitHub (PKCE) -- ChatGPT and Claude both require this
- **WebSocket tunnel** -- persistent bidirectional connection from the desktop daemon
- **Tool forwarding** -- when ChatGPT calls a tool, the Worker forwards it over the WebSocket to the desktop daemon, waits for the result, returns it
- **Device registry** -- KV store for active device sessions
- **Health endpoint** -- GET /health

Tech: TypeScript, `@cloudflare/agents` (McpAgent or createMcpHandler), Cloudflare KV for session state.

**Endpoints:**
- `POST /mcp` -- MCP tools call (Streamable HTTP transport)
- `GET /mcp/sse` -- SSE endpoint for older MCP clients
- `GET /auth/github` -- initiate GitHub OAuth
- `GET /auth/callback` -- OAuth callback
- `WS /tunnel` -- WebSocket endpoint for desktop daemon to connect
- `GET /health` -- health check

### 3.2 Desktop Daemon (`packages/desktop-daemon/`)

A lightweight process that runs in the system tray. Handles:

- **Connects to CF Worker** via WebSocket (outbound only)
- **Registers as a device** (authenticates with device token)
- **Receives MCP tool calls** forwarded from the Worker
- **Runs tools locally** (filesystem, terminal, browser, etc.)
- **Returns results** over the WebSocket
- **Heartbeat** -- every 15s to keep connection alive
- **Reconnection** -- exponential backoff on disconnect
- **Sleep/wake detection** -- pauses on sleep, reconnects on wake

Tech: Node.js (or Go/Rust for smaller footprint), `@modelcontextprotocol/sdk` for tool definitions, `ws` for WebSocket.

**Lifecycle:**
1. Start -> read config (worker URL, device token)
2. Connect WebSocket to `wss://worker.yourdomain.com/tunnel`
3. Authenticate (send device token)
4. Enter loop: receive tool calls -> execute -> send response
5. Heartbeat every 15s
6. On disconnect: exponential backoff, reconnect

### 3.3 MCP Tools (`packages/mcp-server/`)

Shared package defining all MCP tools. Desktop daemon imports and serves these.

**Phase 1 tools (v1 -- coding agent tier):**

| Tool | Description | What it uses |
|---|---|---|
| `read_file` | Read file contents | fs |
| `read_multiple_files` | Batch read up to 10 files | fs |
| `write_file` | Write/overwrite file | fs |
| `edit_file` | Surgical find-and-replace edit | fuzzy patch |
| `create_directory` | mkdir -p | fs |
| `list_directory` | ls with details | fs |
| `move_file` | mv | fs |
| `get_file_info` | stat | fs |
| `search_files` | grep/rg via ripgrep | ripgrep |
| `execute_command` | Run shell command, return output | child_process |
| `execute_command_stream` | Run command, stream output back | child_process + WS |
| `list_processes` | List running processes | os/ps |
| `kill_process` | Kill process by PID | process.kill |
| `browser_navigate` | Navigate to URL (Playwright) | playwright |
| `browser_click` | Click element by selector | playwright |
| `browser_screenshot` | Take page screenshot | playwright |
| `browser_evaluate` | Run JS in page context | playwright |
| `get_environment_info` | OS, arch, env vars | os/process |

**Phase 2 tools (v2 -- computer-use tier):**

| Tool | Description | Notes |
|---|---|---|
| `computer_screenshot` | Capture screen | Wraps Open Computer Use |
| `computer_click` | Mouse click at coordinates | Wraps Open Computer Use |
| `computer_type` | Type text | Wraps Open Computer Use |
| `computer_keypress` | Press key combo | Wraps Open Computer Use |
| `computer_mouse_move` | Move mouse | Wraps Open Computer Use |
| `computer_scroll` | Scroll | Wraps Open Computer Use |
| `computer_list_windows` | List open windows | OS-specific APIs |
| `computer_focus_window` | Focus window by title | OS-specific APIs |

### 3.4 Security Model

**Policy engine** -- a `policy.json` file in the config dir:

```json
{
  "allowed_directories": ["~/projects", "~/Downloads"],
  "blocked_commands": ["rm -rf", "sudo", "shutdown", "reboot"],
  "require_confirmation": ["execute_command", "write_file"],
  "read_only": false,
  "max_file_size": 10485760,
  "allow_browser": true,
  "allow_computer_use": false
}
```

**OAuth flow:**
1. User deploys CF Worker (one click)
2. Installs desktop daemon, configures device token
3. In ChatGPT/Claude settings, adds custom connector with `https://worker.domain.com/mcp`
4. ChatGPT redirects to OAuth -> user approves -> connected

**Device tokens:**
- Generated when daemon first starts
- Stored in `~/.deckagent/config.json`
- Can be rotated from the Worker dashboard

## 4. Directory Structure

```
deckagent/
├── SPEC.md                     # This file
├── README.md                   # What why how
├── LICENSE                     # MIT
├── AGENTS.md                   # For Devin/agents
├── packages/
│   ├── cloudflare-worker/      # CF Worker MCP endpoint
│   │   ├── src/
│   │   │   ├── index.ts        # Entry: MCP handler + OAuth + tunnel
│   │   │   ├── auth.ts         # GitHub OAuth
│   │   │   ├── tunnel.ts       # WebSocket tunnel management
│   │   │   ├── router.ts       # Request routing
│   │   │   └── store.ts        # KV session store
│   │   ├── wrangler.jsonc      # CF config
│   │   └── package.json
│   ├── desktop-daemon/         # System tray daemon
│   │   ├── src/
│   │   │   ├── index.ts        # Entry: main loop
│   │   │   ├── tunnel-client.ts # WebSocket client to Worker
│   │   │   ├── tool-executor.ts # Runs MCP tools locally
│   │   │   ├── policy.ts       # Policy enforcement
│   │   │   └── config.ts       # Config management
│   │   ├── scripts/
│   │   │   ├── install.sh       # Linux/macOS install
│   │   │   └── install.ps1     # Windows install
│   │   └── package.json
│   ├── mcp-server/             # Shared MCP tool definitions
│   │   ├── src/
│   │   │   ├── index.ts        # Tool registry
│   │   │   ├── filesystem.ts   # File ops tools
│   │   │   ├── terminal.ts     # Terminal tools
│   │   │   ├── browser.ts      # Browser tools
│   │   │   ├── computer.ts     # Computer-use tools (v2)
│   │   │   └── schemas.ts      # Zod schemas for all tools
│   │   └── package.json
│   └── cli/                    # CLI installer
│       ├── src/
│       │   ├── index.ts        # "deckagent setup" entry
│       │   ├── deploy-worker.ts # Deploys CF Worker
│       │   ├── install-daemon.ts # Installs desktop daemon
│       │   └── configure.ts    # Config wizard
│       └── package.json
└── reference/
    └── desktop-commander/       # Cloned for reference
```

## 5. Data Flow (Detailed)

### 5.1 Connection setup

```
1. User runs `npx deckagent setup`
2. CLI deploys CF Worker to user's Cloudflare account via Wrangler API
3. CLI installs desktop daemon as a background service
4. Daemon starts, generates device token, connects WebSocket to Worker
5. Worker registers device in KV: { device_id, token, status: "online", last_seen }
6. User goes to ChatGPT settings -> Custom Connectors -> Add
7. User enters URL: https://user-worker.user.workers.dev/mcp
8. ChatGPT redirects to OAuth, user approves via GitHub
9. ChatGPT now can call tools on user's machine
```

### 5.2 Tool call

```
1. ChatGPT sends MCP JSON-RPC to POST /mcp:
   {"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"read_file","arguments":{"path":"/home/user/project/index.ts"}}}

2. Worker parses the request, wraps it in a message, sends over WebSocket to connected daemon

3. Daemon receives the message:
   - Checks policy (is path allowed? is tool allowed?)
   - If requires confirmation and no approval cached, sends confirmation request back
   - Otherwise, executes the tool (reads file via fs)

4. Daemon sends result back over WebSocket:
   {"id":"1","result":{"content":[{"type":"text","text":"file contents..."}]}}

5. Worker forwards the result to ChatGPT via HTTP response

6. If tool uses SSE transport, worker streams progress back
```

## 6. Comparison to Desktop Commander

| | Desktop Commander | DeckAgent |
|---|---|---|
| **Relay** | Supabase (managed by them) | Your own CF Worker |
| **Self-hosted** | No | Yes |
| **Data path** | Through their Supabase | Through your Worker |
| **Cost** | Free tier limited, Pro paid | Free (your CF Worker free tier) |
| **OAuth** | Their auth | Your GitHub OAuth |
| **Tools** | Filesystem, terminal | Filesystem, terminal, browser, (future: computer-use) |
| **Install** | npm package + Claude config | One-command setup |
| **Desktop app** | Yes (paid app) | Open source daemon |
| **Computer-use** | No | Planned (v2) |
| **Platform** | macOS, Linux, Windows | macOS, Linux, Windows |

## 7. Implementation Priority

### Phase 1 -- MVP (coding agent)

The core that makes it useful. Focus on filesystem + terminal tools that work reliably through ChatGPT/Claude web connectors.

- [x] CF Worker with Streamable HTTP MCP transport
- [x] GitHub OAuth
- [ ] WebSocket tunnel handler on Worker
- [ ] Desktop daemon (WebSocket client + tool executor)
- [ ] Filesystem tools (read, write, search, edit, directory)
- [ ] Terminal tools (execute, stream, process management)
- [ ] Policy engine
- [ ] One-command installer (deploys Worker + installs daemon)
- [ ] README with demo video

### Phase 2 -- Desktop power tools

- [ ] Browser automation (Playwright)
- [ ] Display output in ChatGPT (images, markdown)
- [ ] Rich file previews
- [ ] Git integration tools
- [ ] Environment variable management

### Phase 3 -- Computer-use

- [ ] Screen capture
- [ ] Mouse/keyboard simulation
- [ ] Window management
- [ ] Integrate Open Computer Use

### Phase 4 -- Polish

- [ ] Native installers (.dmg, .exe, .deb)
- [ ] GUI config panel
- [ ] Usage analytics (opt-in)
- [ ] Audit log viewer
- [ ] Sharing/community tool packs

## 8. Key Technical Decisions

### Why CF Worker instead of a VPS for the relay?

- Free tier (100k requests/day, 1k req/s)
- Global edge (low latency)
- Workers handle OAuth, KV for state, Durable Objects for sessions
- No server management
- `wrangler` CLI makes deploy one command

### Why WebSocket tunnel instead of HTTP polling?

- Bidirectional -- Worker can push tool calls to daemon
- Low latency -- no polling interval
- Real-time streaming for terminal output
- Connection state is clear (connected/disconnected)

### Why a separate desktop daemon instead of just an MCP server?

- ChatGPT/Claude web MCP requires an HTTPS endpoint
- The MCP server must be reachable from the internet
- Desktop daemon dials OUT (no firewall issues)
- Daemon handles computer-use (screen capture, mouse/keyboard) which needs local process

### Why not just use Desktop Commander's MCP server directly?

- Desktop Commander's remote relay goes through their Supabase
- Their remote feature requires their paid desktop app
- No computer-use support
- This project is for people who want full control of their infra

## 9. Devin Prompt (TL;DR for Devin)

```
Build a self-hosted MCP bridge called DeckAgent.

Architecture:
- Cloudflare Worker (public MCP endpoint with OAuth + WebSocket tunnel)
- Desktop daemon (system tray app, connects to Worker via WebSocket, executes tools locally)
- Shared MCP tool package (filesystem, terminal, browser tools)

The Worker uses Cloudflare Agents SDK (McpAgent or createMcpHandler) for Streamable HTTP MCP transport.
OAuth uses GitHub (PKCE flow).
Desktop daemon is a Node.js process that reads from WebSocket, runs tools, sends results back.

Directory structure is in packages/cloudflare-worker, packages/desktop-daemon, packages/mcp-server.
Start with the Worker, then the daemon, then the tools. Policy engine enforces allowed_directories and blocked_commands.

See SPEC.md for full details.
```
