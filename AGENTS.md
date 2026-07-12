# DeckAgent

## Build Instructions for Devin

This project is a self-hosted MCP bridge that gives web AI (ChatGPT, Claude, Gemini) hands on your computer.

**Architecture at a glance:**
- `packages/cloudflare-worker/` -- Cloudflare Worker as public MCP endpoint (OAuth + WebSocket tunnel)
- `packages/desktop-daemon/` -- System tray daemon on user's machine that connects to Worker
- `packages/mcp-server/` -- Shared MCP tool definitions (filesystem, terminal, browser)
- `packages/cli/` -- Installer CLI (`npx deckagent setup`)

**Build order:**
1. `packages/mcp-server/` -- Tool schemas + implementations (no server, just tool logic)
2. `packages/cloudflare-worker/` -- MCP HTTP endpoint, OAuth, WebSocket tunnel
3. `packages/desktop-daemon/` -- WebSocket client, tool executor, lifecycle
4. `packages/cli/` -- One-command install

**Tech stack:**
- Cloudflare Workers with `@cloudflare/agents` (McpAgent or createMcpHandler)
- Streamable HTTP MCP transport
- GitHub OAuth (PKCE)
- WebSocket tunnel (bi-directional)
- TypeScript throughout
- Desktop daemon: Node.js (or Go/Rust for smaller footprint)
- Policy engine: JSON config file

**Security:**
- Policy file controls allowed dirs and blocked commands
- Device tokens authenticate daemon to Worker
- OAuth 2.1 for ChatGPT/Claude connector auth
- No open ports on user machine (all outbound)

**Read SPEC.md for full architectural details.**
