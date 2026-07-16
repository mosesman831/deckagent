# Milestone 3.4 — F8 / F9 / F10 Implementation Spec

> Status: **IMPLEMENTED**  
> Builds on F1–F7 + Wave 4 security.

---

## F8 — Device tools + sticky preferred device

### Goals
1. Agents can discover online/offline devices without guessing UUIDs.
2. Multi-device setups stop returning `DEVICE_AMBIGUOUS` when a preferred device is configured.

### Worker
1. Add MCP tool `list_devices` (Worker-local — does **not** forward to daemon):
   - Returns `{ devices: [{ id, name, status, last_seen }] }` from KV (same data as `deckagent://devices`).
   - Empty args object; Zod/JSON Schema: `{ type: "object", properties: {} }`.
2. Sticky preferred device resolution order in `resolveTargetDeviceId` / MCP routing:
   1. Explicit `params.deviceId` (or `arguments.device_id` stripped before forward — keep existing `params.deviceId`)
   2. Request header `X-DeckAgent-Device-Id`
   3. KV key `pref:default_device` (string device id) **if that device is online**
   4. Sole online device
   5. Else `DEVICE_AMBIGUOUS` / `DEVICE_OFFLINE` as today
3. API:
   - `PUT /api/devices/prefer` body `{ "device_id": "<uuid>" }` — sets KV sticky (Bearer auth)
   - `DELETE /api/devices/prefer` — clears sticky
   - Include sticky id in `deckagent://devices` JSON as `preferred_device_id`
4. Handle `list_devices` in `mcp-handler` **before** DO forward (like initialize).
5. Mirror changes into `packages/cli/assets/worker/`.

### CLI
- `deckagent device list` — GET devices via Worker API or local config hint
- `deckagent device prefer <device_id>` — PUT prefer + write `preferred_device_id` to `~/.deckagent/config.json`
- `deckagent device clear` — clear sticky

### Config
- Add optional `preferred_device_id: z.string().uuid().optional()` to CLI + daemon ConfigSchema (daemon may ignore; CLI uses it when calling prefer API).

### Tests
- Worker: sticky prefer resolves multi-device; list_devices tool; header override
- CLI: device command smoke test

---

## F9 — Custom tool plugins

### Goals
User drops a plugin under `~/.deckagent/plugins/` and it appears in `tools/list` after daemon restart (or hot-reload once at startup is enough).

### Layout
```
~/.deckagent/plugins/
  example/
    plugin.json
    index.mjs
```

### `plugin.json`
```json
{
  "name": "hello_plugin",
  "description": "Say hello",
  "version": "1.0.0",
  "entry": "index.mjs",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" }
    },
    "required": ["message"]
  },
  "require_confirmation": true
}
```

### `index.mjs` contract
```js
export async function run(args) {
  return {
    content: [{ type: "text", text: JSON.stringify(args) }],
    isError: false
  };
}
```

### Daemon
1. New `packages/desktop-daemon/src/plugins.ts`:
   - Scan `~/.deckagent/plugins/*/plugin.json`
   - Dynamic `import()` entry (file URL)
   - Validate name: `/^[a-z][a-z0-9_]{1,63}$/`, must not collide with builtin tools
   - Register into ToolRegistry **or** parallel plugin map executed from tool-executor
2. Policy:
   - `allow_plugins: boolean` (default **false** in strict/locked, **true** in dev)
   - When false → do not load / do not expose plugins
   - Plugin tools auto-added to `require_confirmation` when `require_confirmation: true` in manifest
3. Caps: include plugin tool names in `policy_caps.enabled_tools` when loaded
4. Audit: log `plugin:<name>` executions (no large payloads)

### Worker
- Static catalog does **not** need every plugin; filtered `tools/list` already comes from daemon via TunnelDO. Optionally document that plugins only appear when daemon online.
- Do **not** add plugins to static TOOL_CATALOG.

### CLI
- `deckagent plugin list` — list discovered plugins + enabled/disabled
- Document in README briefly

### Tests
- Load a temp plugin fixture, execute, deny when `allow_plugins: false`
- Name collision with `read_file` rejected

### Security
- Only load from `~/.deckagent/plugins/` (realpath must stay under that root)
- No network helpers injected; plugins get only `args`
- Fail closed on import/schema errors (log + skip)

---

## F10 — Watchdog health + `doctor --watch`

### Goals
1. Daemon writes a health heartbeat file so external monitors can see liveness.
2. `deckagent doctor --watch` continuously reports health and exits non-zero on sustained failure.

### Daemon
1. Write `~/.deckagent/health.json` every heartbeat (15s default):
```json
{
  "ok": true,
  "pid": 1234,
  "device_id": "...",
  "tunnel": "connected" | "connecting" | "disconnected",
  "last_heartbeat_at": "ISO-8601",
  "worker_url": "https://...",
  "version": "..."
}
```
2. On SIGTERM/SIGINT: set `ok: false` / remove file or mark disconnected before exit.
3. Optional internal watchdog: if tunnel disconnected > 5 minutes, log warn (reconnect already exists — do not reinvent; just expose status).

### CLI `deckagent doctor [--watch] [--interval 5] [--fail-after 30]`
- Existing one-shot doctor stays default.
- `--watch`: loop every `--interval` seconds (default 5).
- Re-run checks; also read `health.json` freshness (`last_heartbeat_at` within 2× heartbeat interval).
- Print compact one-line status each tick.
- Exit `1` if unhealthy continuously for `--fail-after` seconds (default 30).
- Exit `0` on Ctrl+C only if currently healthy? Prefer: Ctrl+C → exit 130; sustained fail → exit 1.

### Tests
- Doctor watch: mock health file stale → fail-after trips (unit test with fake clock or short intervals)
- Daemon health writer unit test

---

## Build order reminder
mcp-server (only if new schemas for list_devices — Worker-local may skip mcp-server) → worker → daemon → cli.

## Acceptance
- [x] F8: multi-device + prefer → tools/call routes without DEVICE_AMBIGUOUS
- [x] F8: `list_devices` in tools/list and tools/call
- [x] F9: plugin loads when allow_plugins; blocked when not
- [x] F10: health.json updates; `doctor --watch --fail-after 2` fails on stale health
- [x] All package tests green; update WAVE3_FEATURE_SPEC status
