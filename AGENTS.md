# AGENTS.md — Devin Build Instructions

## RULES (NON-NEGOTIABLE)

1. BUILD ORDER: packages/mcp-server → packages/cloudflare-worker → packages/desktop-daemon → packages/cli. NEVER deviate.
2. Every tool MUST have Zod schema validation. No `any`.
3. All errors MUST be human-readable. No raw Node.js error objects.
4. Policy enforcement is in the daemon, NOT the Worker.
5. WebSocket messages ARE JSON-line-delimited. One JSON per line, terminated by `\n`. NOT binary frames.
6. All config in `~/.deckagent/config.json`. NO env vars.
7. Daemon runs as user-space process. NO sudo, NO root.
8. Log to `~/.deckagent/logs/`. 10MB rotation. Keep 5 files.
9. EVERY tool gets a smoke test. NO untested code.

## WHAT TO BUILD

### Overview

DeckAgent is a self-hosted MCP bridge. The user deploys a Cloudflare Worker, installs a desktop daemon, and pastes the Worker URL into ChatGPT/Claude web custom connectors. The web AI can then call tools on their real computer — read/write files, run terminal commands, control a browser.

### Architecture

```
ChatGPT/Claude/Gemini Web
    ↓  HTTPS POST /mcp (Streamable HTTP, Bearer token auth)
Cloudflare Worker  ← user deploys this to their CF account
    ↓  WebSocket wss://.../tunnel (JSON-line-delimited messages)
Desktop Daemon  ← system tray app on user's machine
    ↓  Executes tools locally
Filesystem · Terminal · Browser tools
```

### 3 packages (build in this order):

#### 1. packages/mcp-server/
- Pure tool implementations (no server, no I/O transport)
- Filesystem tools: read_file, write_file, edit_file, search_files, list_directory, create_directory, move_file, get_file_info, read_multiple_files
- Terminal tools: execute_command, execute_command_stream, list_processes, kill_process
- Browser tools: browser_navigate, browser_screenshot, browser_click, browser_evaluate
- Environment tools: get_environment
- Export a `ToolRegistry` class with `register()`, `get()`, `list()`, `execute()`
- All schemas in schemas.ts using Zod
- Each tool is a pure async function

#### 2. packages/cloudflare-worker/
- MCP Streamable HTTP endpoint at POST/GET /mcp
- Bearer token auth at /mcp (static API_TOKEN)
- WebSocket tunnel at /tunnel (handles JSON-line-delimited messages)
- Device registration API at POST /api/devices
- KV namespace "DECK_KV" for sessions, devices, OAuth state
- Tool calls received at /mcp are forwarded over WebSocket to daemon
- See SPEC.md §2 for exact protocols

#### 3. packages/desktop-daemon/
- WebSocket client connects to Worker's /tunnel
- Receives execute_tool messages, validates with policy, executes via mcp-server
- Policy engine (allowed_directories, blocked_commands, require_confirmation, read_only)
- Heartbeat every 15s, reconnect with exponential backoff
- Signals: on SIGTERM/SIGINT cleanup and exit
- Config in ~/.deckagent/config.json

#### 4. packages/cli/ (MAKE IT WORK PERFECTLY)
- `deckagent setup`: Full setup wizard
  - Check prereqs (node, npm, wrangler, git)
  - Log into Cloudflare via wrangler
  - Create KV namespace
  - Guide user to create GitHub OAuth App
  - Deploy Worker
  - Register device
  - Write config files
  - Install daemon as LaunchAgent (macOS) or systemd user service (Linux)
  - Start daemon
- `deckagent daemon [--foreground]`: Start/stop/status
- `deckagent logs`: Tail logs
- `deckagent uninstall`: Remove everything

## REFERENCE CODE

`reference/desktop-commander/` contains the MIT-licensed Desktop Commander source. Use it for:
- Understanding how they structure MCP tools (filesystem.ts, process.ts)
- Their fuzzy search implementation (fuzzySearch.ts)
- Their terminal manager (terminal-manager.ts)
- Pattern inspiration only. Do NOT copy-paste. Write fresh code.

## KEY DESIGN DECISIONS

| Decision | Why |
|---|---|
| CF Worker + WebSocket tunnel | User owns infra. No relay. Outbound-only connection. |
| Streamable HTTP MCP transport | Supported by ChatGPT + Claude web. No SSE needed. |
| Bearer token auth | ChatGPT's custom connector supports it. Simpler than OAuth. |
| ToolRegistry pattern | Clean separation of tool logic from transport. Testable. |
| Policy in daemon, not Worker | Worker is stateless. Policy needs filesystem access. |

## COMMON PITFALLS

- MCP JSON-RPC responses MUST include "jsonrpc": "2.0" and "id" field
- WebSocket text frames, not binary frames
- Cloudflare Workers have a 10ms CPU time per request limit for free tier — don't do heavy processing in the Worker
- KV has eventual consistency — reads may not reflect recent writes
- Don't use `process.env` in Workers (use `env` in the handler)
- desktop-daemon needs `ws` package installed (not built into Node.js)
- On macOS, LaunchAgent needs full disk access permission for filesystem tools

## EXECUTION

Build packages sequentially. Test each before moving to the next.
The SPEC.md has the exact schemas, protocols, error handling, and data structures.
Every message format, every KV key pattern, every config field is specified.
Build it.
