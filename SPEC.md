# DeckAgent Specification Index

This file is the canonical starting point for DeckAgent architecture, protocol, and production-readiness documentation. Detailed feature specs live under `docs/`; this index explains how they fit together.

## Product summary

DeckAgent is a self-hosted MCP bridge:

1. A web MCP client (ChatGPT, Claude, Gemini, or a compatible client) sends JSON-RPC over HTTPS to a user-owned Cloudflare Worker.
2. The Worker authenticates the request with a static Bearer token and forwards tool calls through a Durable Object WebSocket tunnel.
3. The desktop daemon keeps an outbound WebSocket connection to the Worker and executes tools locally after daemon-side policy checks.
4. Tool implementations live in `packages/mcp-server`; transports and policy are kept outside the pure tool layer.

## Architecture

```text
Web MCP client
  -> HTTPS POST/GET /mcp (JSON-RPC 2.0, Bearer API_TOKEN)
Cloudflare Worker
  -> WebSocket /tunnel (JSON-line-delimited text messages)
Desktop Daemon
  -> packages/mcp-server tools
  -> local filesystem, terminal, browser
```

Package responsibilities:

| Package | Responsibility |
|---------|----------------|
| `packages/mcp-server` | Pure async tool implementations, Zod schemas, `ToolRegistry` |
| `packages/cloudflare-worker` | Streamable HTTP MCP endpoint, Bearer auth, device APIs, Durable Object tunnel |
| `packages/desktop-daemon` | Tunnel client, policy enforcement, confirmations, audit/logging, local UI |
| `packages/cli` | Setup, daemon lifecycle, policy/workspace/device/plugin/token commands |
| `packages/v2-extension` | Experimental browser extension adapters for additional AI web chats |

Build and release work must follow the order in [`AGENTS.md`](AGENTS.md): `mcp-server -> cloudflare-worker -> desktop-daemon -> cli`.

## Protocols

### MCP HTTP

- Endpoint: `POST /mcp` for JSON-RPC requests; `GET /mcp` for compatible stream/list behavior where implemented.
- Authentication: `Authorization: Bearer <api_token>`.
- OAuth is not implemented; operators rotate the Bearer token with `deckagent token rotate`.
- Responses must include `jsonrpc: "2.0"` and the original `id` for JSON-RPC calls.
- Policy and budget denials should surface as MCP tool results with `isError: true` when they are recoverable tool errors.

### Worker tunnel

- Endpoint: `wss://<worker>/tunnel?device_id=<uuid>&token=<device-token>`.
- Frames are text frames containing JSON lines: one JSON object per line, terminated by `\n`.
- The Worker sends `auth_ok`, tool execution requests, resource reads, and capability refresh messages.
- The daemon sends tool results, heartbeats, health/capability updates, and resource responses.

### Device APIs

- `POST /api/devices` registers a daemon device.
- `GET /api/devices` lists known devices.
- `PUT /api/devices/prefer` and `DELETE /api/devices/prefer` manage the sticky preferred device.
- Device APIs use the same Worker Bearer token and Zod-validated JSON bodies.

### Local daemon surfaces

- Confirmation server: loopback-only approval pages for gated tool calls.
- Control UI: loopback-only UI on `127.0.0.1:9150`, protected by `~/.deckagent/ui.token`.
- Config: all user config lives under `~/.deckagent/`; no user-facing environment variables are required.

## Security model

- The daemon is the enforcement point for policy. The Worker is not trusted to decide local filesystem, terminal, plugin, or browser policy.
- Missing or invalid policy defaults to strict/fail-closed behavior.
- Sensitive paths, denied paths, symlink escapes, read-only mode, command policy, browser host policy, and policy locks are enforced before tool execution.
- `terminal_mode=sandbox_fs` must use a real OS sandbox (`bwrap` on Linux); if unavailable, the daemon denies execution.
- Custom plugins are trusted local code and remain disabled in strict/locked profiles.

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY_ENFORCEMENT_SPEC.md`](docs/SECURITY_ENFORCEMENT_SPEC.md) for the detailed hardening model.

## Canonical detailed specs

| Spec | Purpose |
|------|---------|
| [`AGENTS.md`](AGENTS.md) | Non-negotiable build, packaging, policy, logging, and testing rules |
| [`docs/WAVE3_FEATURE_SPEC.md`](docs/WAVE3_FEATURE_SPEC.md) | Implemented Wave 3 features F1-F10 |
| [`docs/WAVE3_MILESTONE_34_SPEC.md`](docs/WAVE3_MILESTONE_34_SPEC.md) | Implemented F8-F10 device, plugin, and watchdog details |
| [`docs/SECURITY_ENFORCEMENT_SPEC.md`](docs/SECURITY_ENFORCEMENT_SPEC.md) | Implemented Wave 4 hard security enforcement |
| [`docs/PRODUCTION_READINESS_SPEC.md`](docs/PRODUCTION_READINESS_SPEC.md) | Production-readiness P0–P2 hardening (implemented) |
| [`docs/WAVE5_OPERATOR_SPEC.md`](docs/WAVE5_OPERATOR_SPEC.md) | Wave 5 onboard/smoke, diffs, jobs, revoke, integrity, e2e |
| [`docs/WAVE6_POLISH_SPEC.md`](docs/WAVE6_POLISH_SPEC.md) | Wave 6 UI/CLI/Worker/catalog quality polish |
| [`README.md`](README.md) | Operator-facing install, feature status, and usage guide |
| [`SECURITY.md`](SECURITY.md) | Vulnerability reporting, hardening checklist, and residual risks |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes and shipped-change summary |

## Current production-readiness status

Implemented:

- P0–P2 hardening: real `sandbox_fs`, restore path checks, strict defaults, publishable packages, CSRF/UI tokens, plugin isolation, browser host enforcement, soft MCP errors, rate limits, safer uninstall, rotation, metrics, abort signals, release workflow, token rotate.
- Wave 5 operator experience: `deckagent onboard` / `smoke`, confirmation diffs, device revoke, background jobs, plugin integrity pins, ops alerts, `npm run e2e:mcp`.

Not shipped (intentionally deferred):

- ChatGPT OAuth connector flow (Bearer-only by design today).
- Chrome Web Store publication for the experimental v2 extension.
- Multi-tenant SaaS, team billing, or hosted relay mode.
- Full OS computer-use suite beyond Playwright page tools.
- Signed native installers (Homebrew / pkg / msi).
