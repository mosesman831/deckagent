# DeckAgent

> Self-hosted MCP bridge that gives web AI (ChatGPT, Claude, Gemini) hands on your computer.

```
 ███████████                                          ███████████
 █         █                                          █         █
 █ ChatGPT █ ──HTTPS POST /mcp (Streamable HTTP)────> █  Your   █
 █ Claude  █           Authorization: Bearer          █ Worker  █
 █ Gemini  █                                          █         █
 ███████████                                          ███████████
                                                           │
                                                           │ WebSocket wss://.../tunnel
                                                           │ JSON-line-delimited messages
                                                           ▼
                                                    █████████████
                                                    █           █
                                                    █  Desktop  █
                                                    █  Daemon   █
                                                    █           █
                                                    █████████████
                                                           │
            ┌────────────────┬────────────────┬────────────┴────────┐
            ▼                ▼                ▼                     ▼
      ███████████      ███████████      ███████████           ███████████
      █ Filesystem █      █ Terminal  █      █ Browser   █           █Computer █
      █   tools    █      █   tools   █      █   tools   █           █  Use    █
      ███████████      ███████████      ███████████           ███████████
```

Deploy your own Cloudflare Worker, run a local desktop daemon, and paste one URL into ChatGPT, Claude, or Gemini. Your web AI can now read files, run terminal commands, and control a browser on your machine — fully self-hosted, with no third-party relay.

## Quick Start

```bash
npx deckagent setup
```

Then add the printed Worker URL to ChatGPT / Claude / Gemini as a custom MCP connector.

## Features

- **Self-hosted** — your Worker, your Cloudflare account, your data
- **No relay** — direct WebSocket tunnel from the Worker to your local daemon
- **Filesystem tools** — read, write, edit, search, list, move files
- **Terminal tools** — run commands, list and kill processes
- **Browser tools** — navigate, screenshot, click, evaluate JS via Playwright
- **Policy engine** — allow/block directories, block commands, read-only mode, confirmation gates
- **GitHub OAuth PKCE** — works with ChatGPT/Claude/Gemini custom connectors
- **Cross-platform** — macOS, Linux, Windows

## Demo / Screenshot

> Screenshot placeholder — show ChatGPT calling `read_file` on a local project.

## How It Compares

| Feature | DeckAgent | Desktop Commander |
|---|---|---|
| Hosting | Self-hosted (your Cloudflare Worker) | Commercial relay |
| Source code | Open source (MIT) | Closed source / freemium |
| Data path | Direct Worker ⟷ your machine | Routes through vendor servers |
| Cost | Free (Cloudflare free tier) | Paid for remote/team use |
| AI support | ChatGPT, Claude, Gemini web | Primarily Claude Desktop |
| Policy control | Local `policy.json` | Cloud-controlled |
| Browser automation | Built-in | Limited |

## Security

- The daemon runs as a normal user process, never as root.
- All traffic is HTTPS / WSS; there are no open inbound ports on your machine.
- Tool execution is gated by a local `policy.json`:
  - `allowed_directories` limits where the AI can read/write
  - `blocked_commands` prevents dangerous shell commands
  - `read_only` disables all mutation tools
  - `require_confirmation` forces user approval for destructive actions
- OAuth is handled via GitHub PKCE; tokens never appear in URLs.
- The Cloudflare Worker is stateless; secrets and sessions live in KV.

## Configuration

All configuration lives in `~/.deckagent/`:

```
~/.deckagent/
├── config.json      # device_id, token, worker_url, preferences
├── policy.json      # allowed dirs, blocked commands, confirmations
└── logs/
    └── deckagent-YYYY-MM-DD.log
```

Example `config.json`:

```json
{
  "device_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "token": "deadbeef...",
  "worker_url": "https://deckagent.your-name.workers.dev",
  "device_name": "My MacBook Pro",
  "log_level": "info"
}
```

Example `policy.json`:

```json
{
  "allowed_directories": ["/home/me/projects"],
  "blocked_commands": ["sudo", "rm -rf /"],
  "read_only": false
}
```

## Development

This repo is an npm workspace with four packages:

```
packages/
├── mcp-server          # Pure MCP tool implementations
├── cloudflare-worker   # Worker endpoint, OAuth, tunnel
├── desktop-daemon      # WebSocket client + policy + tool executor
└── cli                 # `deckagent` command-line setup wizard
```

Install and build everything:

```bash
npm install
npm run build
```

Run the smoke test:

```bash
npm test
```

## Architecture

See [SPEC.md](SPEC.md) for the full protocol, message formats, KV schema, and build order.

## License

MIT
