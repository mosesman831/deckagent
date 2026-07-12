# DEVIN PROMPT — COPY AND PASTE THIS INTO DEVIN

```
Build a self-hosted MCP bridge called DeckAgent.

Github repo: https://github.com/mosesman831/deckagent (private)

Read SPEC.md and AGENTS.md in the repo root. They contain the full architecture, protocols, data structures, error handling, and build order.

BUILD IN THIS EXACT ORDER:
1. packages/mcp-server/ — Pure tool implementations (filesystem, terminal, browser, environment) with Zod schemas. No I/O transport. Export ToolRegistry class.
2. packages/cloudflare-worker/ — Cloudflare Worker with Streamable HTTP MCP endpoint, GitHub OAuth PKCE, WebSocket tunnel, KV device registry.
3. packages/desktop-daemon/ — WebSocket client connecting to the Worker, receives tool calls, validates with policy engine, executes via mcp-server.
4. packages/cli/ — One-command setup flow: deploys Worker, registers device, installs daemon as background service.

CRITICAL RULES:
- Every tool MUST have Zod schema validation. No `any` types.
- WebSocket messages are JSON-line-delimited (one JSON per line, terminated by \n).
- Policy enforcement happens in the daemon, NOT the Worker.
- Daemon runs as user-space process. No sudo, no root.
- OAuth uses GitHub PKCE. No exceptions.
- All config in ~/.deckagent/config.json. No env vars.
- Log to ~/.deckagent/logs/. 10MB rotation. Keep 5 files.
- Every tool needs a smoke test.

The SPEC.md has exact message formats, KV schemas, error codes, endpoint signatures, config structures, and lifecycle flows. Follow them exactly.

BUILD IT.
```
