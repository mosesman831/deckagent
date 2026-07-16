# DeckAgent — Next Features Plan & Spec (Wave 3)

> Status: **F1–F7 IMPLEMENTED** (Wave 3.1–3.3). F8–F10 still stretch.  
> Assumes Wave 1 (core bridge) + Wave 2 (production readiness + audit/allowlist/packaging/prompts) are working.

---

## 1. Goals for this wave

Make DeckAgent feel like a **safe daily driver** for agentic coding, not just a demo tunnel:

1. Agents stay inside a chosen project by default.
2. Users can see history, devices, and policy through MCP (not only logs on disk).
3. Destructive edits are reversible.
4. Secrets never appear in model context.
5. Runaway agents are rate-limited.
6. Approvals + status are visible in a tiny local UI (not only terminal + OS toast).

Non-goals for Wave 3:

- Multi-tenant SaaS / billing
- Mobile apps
- Full computer-use / GUI automation suite
- Replacing Playwright with a custom browser engine

---

## 2. Feature shortlist (prioritized)

| ID | Feature | Why | Priority |
|----|---------|-----|----------|
| F1 | **Workspaces (project scope)** | Stop agents wandering into `$HOME`; one-command “work on this repo” | **P0 ✅** |
| F2 | **MCP Resources** | Playgrounds + Claude/Cursor can browse audit/policy/devices without new tools | **P0 ✅** |
| F3 | **Edit snapshots + undo** | Trust for `write_file` / `edit_file` | **P0 ✅** |
| F4 | **Secrets vault** | `execute_command` can use `GITHUB_TOKEN` without the model seeing it | **P0 ✅** |
| F5 | **Local control UI** (`127.0.0.1:9150`) | Approvals queue, live status, recent audit, policy toggles | **P1 ✅** |
| F6 | **Rate limits & budgets** | Cap tool calls / shell minutes / bytes written per hour | **P1 ✅** |
| F7 | **True Streamable HTTP SSE progress** | Long builds stream to MCP clients, not only buffered `tool_progress` | **P1 ✅** |
| F8 | **Device tools** (`list_devices`, sticky device) | Multi-machine setups stop being footguns | **P1** |
| F9 | **Custom tool plugins** | User drops a JS/TS tool into `~/.deckagent/plugins` | **P2** |
| F10 | **Scheduled / watchdog health** | Daemon self-heals + `deckagent doctor --watch` | **P2** |

**Recommended Wave 3 ship set:** F1–F6 (+ F7 if time). F8–F10 follow immediately after.

---

## 3. Detailed specs

### F1 — Workspaces (project scope)

#### Problem
Default allowlists of Documents/Desktop/`~/DeckAgent` are safer than `$HOME`, but coding agents still need a **current project root**. Without it, paths are ambiguous and policy is either too wide or too annoying.

#### User stories
- As a user, I run `deckagent workspace use ~/code/myapp` and the AI is scoped there.
- As an agent, `get_environment` tells me `workspace_root`, and relative paths resolve against it.
- As a user, I can temporarily allow a path outside the workspace via confirmation.

#### Config (`~/.deckagent/config.json`)
```json
{
  "workspace": {
    "root": "/Users/me/code/myapp",
    "name": "myapp",
    "allow_outside_with_confirmation": true
  }
}
```

#### Policy interaction
- Effective allowlist = intersection of `policy.allowed_directories` **and** workspace root (workspace must be under an allowed directory, or auto-added on `workspace use`).
- If tool path is outside workspace:
  - If `allow_outside_with_confirmation` → require confirmation (even if tool not normally gated)
  - Else → `ACCESS_DENIED`

#### CLI
```bash
deckagent workspace use <path>
deckagent workspace status
deckagent workspace clear
```

#### Tool / env changes
- `get_environment` adds: `workspace_root`, `workspace_name`
- Path-bearing tools accept relative paths → resolve with `path.resolve(workspace_root, input)`
- New prompt `deckagent_workspace` describing current root + rules

#### Acceptance tests
- Relative `read_file("src/index.ts")` reads `workspace/src/index.ts`
- Absolute path outside workspace denied (or confirmation) per config
- `workspace clear` restores previous behavior

---

### F2 — MCP Resources

#### Problem
`resources/list` currently returns `[]`. Playgrounds and serious clients expect resources for context the model can pull on demand.

#### Resources (URI scheme `deckagent://`)

| URI | MIME | Description |
|-----|------|-------------|
| `deckagent://about` | `text/markdown` | Identity + how to use (short) |
| `deckagent://policy` | `application/json` | Current policy (secrets redacted) |
| `deckagent://workspace` | `application/json` | Active workspace |
| `deckagent://devices` | `application/json` | Registered/online devices |
| `deckagent://audit/recent` | `application/x-ndjson` | Last N audit lines (default 100) |
| `deckagent://session/instructions` | `text/markdown` | Same content as `initialize.instructions` |

#### Protocol
- Advertise `capabilities.resources = { subscribe: false, listChanged: false }` initially
- Implement: `resources/list`, `resources/read`
- `resources/read` for audit must never include raw file contents or secrets (reuse audit redaction)

#### Worker vs daemon
- Static/about/instructions: Worker can serve
- Policy/workspace/audit: **must** come from daemon over tunnel (`resource_read` message) because they are local

#### New tunnel messages
```json
{"type":"read_resource","id":"...","uri":"deckagent://audit/recent","args":{"limit":100}}
{"type":"resource_result","id":"...","contents":[{"uri":"...","mimeType":"...","text":"..."}]}
{"type":"resource_error","id":"...","error":{"code":"NOT_FOUND","message":"..."}}
```

#### Acceptance tests
- `resources/list` returns ≥5 entries
- `resources/read` `deckagent://policy` matches daemon policy
- Unauthorized URI → clean error
- Playground connector smoke extended with resources/read

---

### F3 — Edit snapshots + undo

#### Problem
Agents overwrite files; users need a one-step undo without git archaeology.

#### Behavior
Before every successful `write_file`, `edit_file`, or `move_file` (source), daemon stores a snapshot:

```
~/.deckagent/snapshots/<yyyy-mm-dd>/<uuid>.json
```

Snapshot metadata:
```json
{
  "id": "uuid",
  "ts": "ISO-8601",
  "tool": "edit_file",
  "path": "/abs/path",
  "prev_hash": "sha256",
  "blob_path": "....bin",
  "workspace": "/optional"
}
```

Blobs stored compressed; retain last **50** snapshots or **7 days** (whichever first).

#### New tools
| Tool | Args | Result |
|------|------|--------|
| `list_snapshots` | `path?`, `limit?` | Recent snapshots |
| `restore_snapshot` | `id` | Restores file bytes; itself snapshotted | 

Both respect policy paths; `restore_snapshot` is mutating → confirmation by default.

#### Acceptance tests
- edit → list_snapshots shows entry → restore returns previous content
- snapshots rotated when over cap
- read-only mode blocks restore

---

### F4 — Secrets vault

#### Problem
Users need commands like `gh release create` with tokens, but putting secrets in prompts/tool args is unsafe and audited poorly.

#### Storage
```
~/.deckagent/secrets.json   # mode 0600
```
```json
{
  "version": 1,
  "secrets": {
    "GITHUB_TOKEN": { "value": "...", "created_at": "..." }
  }
}
```

Never sent to Worker. Never returned by tools. Never written to audit (redact by key name + `***`).

#### CLI
```bash
deckagent secret set GITHUB_TOKEN
deckagent secret list          # names only
deckagent secret delete NAME
```

#### Execution rules
- `execute_command` / stream merge vault into `env` **after** user-provided env
- Optional arg `use_secrets?: string[]` — if omitted, inject **none** by default (explicit beat implicit)
- Policy flag `allow_secret_injection` default `true`
- Model sees only: `"secrets_injected": ["GITHUB_TOKEN"]` in result metadata text footer (optional)

#### Acceptance tests
- Secret value never appears in audit.jsonl or tool result text
- Without `use_secrets`, process env lacks the secret
- With `use_secrets: ["GITHUB_TOKEN"]`, child sees it

---

### F5 — Local control UI

#### Problem
Confirmation URLs and logs are power-user UX. Need a persistent local page.

#### Scope (minimal)
Static UI served by daemon at `http://127.0.0.1:9150` (loopback only):

**Pages / panels**
1. **Status** — Worker URL, online?, protocol version, workspace
2. **Approvals** — live queue with Approve/Deny (reuse confirmation-server logic)
3. **Audit** — last 50 events
4. **Policy toggles** — `read_only`, `allow_browser`, `command_mode` (write policy.json safely)

No accounts. No remote bind. Optional token in config for UI mutations later.

#### Implementation sketch
- Extend daemon HTTP: either reuse confirmation server host with path router, or new `control-ui.ts` on 9150
- Vanilla HTML/CSS/JS (no React build) for zero deps
- SSE or poll `/api/status` every 2s

#### Acceptance tests
- Binding non-loopback fails closed
- Approve from UI unblocks waiting tool call
- Toggle read_only reflects in next tool policy check

---

### F6 — Rate limits & budgets

#### Config (`policy.json`)
```json
{
  "budgets": {
    "max_tool_calls_per_hour": 300,
    "max_shell_seconds_per_hour": 600,
    "max_bytes_written_per_hour": 50000000,
    "max_confirmations_per_hour": 60
  }
}
```

#### Behavior
- Daemon tracks rolling 1-hour counters in memory + `~/.deckagent/budgets.json` for restart survival
- Exceed → tool_error `BUDGET_EXCEEDED` with human message and reset time
- `get_environment` includes remaining budget summary

#### Acceptance tests
- After N calls, N+1 fails with `BUDGET_EXCEEDED`
- Counters survive daemon restart (within hour window)

---

### F7 — Streamable HTTP SSE progress (brief)

#### Problem
`tool_progress` is merged into the final JSON-RPC result. Clients that speak Streamable HTTP SSE never see live output.

#### Spec (MVP)
- On `tools/call` for `execute_command_stream`, Worker responds with `Content-Type: text/event-stream`
- Events:
  - `event: progress` data: `{"chunk":"..."}`
  - `event: result` data: final tool result JSON
  - `event: error` data: error JSON
- Non-stream tools keep JSON responses
- Smoke profile `mcpplayground` validates SSE accept header path

---

### F8 — Device tools (brief)

| Tool | Purpose |
|------|---------|
| `list_devices` | Online/offline devices from Worker (daemon asks Worker or Worker serves resource) |
| Sticky header / config `preferred_device_id` | Avoid `DEVICE_AMBIGUOUS` |

Prefer implementing as resource `deckagent://devices` first (F2); add tools only if clients don't read resources well.

---

## 4. Protocol & package impact map

| Package | F1 | F2 | F3 | F4 | F5 | F6 | F7 |
|---------|----|----|----|----|----|----|----|
| mcp-server | relative paths, env fields, snapshot tools | — | snapshot tools | `use_secrets` arg | — | — | stream callback already |
| desktop-daemon | workspace resolve + policy | resource_read handler | snapshot store | vault inject | control UI | budgets | progress already |
| cloudflare-worker | — | resources proxy | catalog | — | — | — | SSE response |
| cli | workspace + secret commands | — | — | secret CLI | open UI hint | — | — |
| v2-extension | read workspace from get_environment | optional | — | — | — | — | — |

Build order remains: **mcp-server → worker → daemon → cli** (+ extension last).

---

## 5. Security requirements (all features)

1. Loopback-only for any new local HTTP ports (9148/9147/9150).
2. All new mutating tools default onto `require_confirmation` unless read-only.
3. Audit every new tool; redact secrets and file bodies.
4. No new env-var config — keep `~/.deckagent/*.json`.
5. Zod schemas for every new tool/resource argument.
6. Human-readable errors only.
7. Smoke tests for every new tool + resource URI.

---

## 6. Rollout plan

### Milestone 3.1 — Scope & visibility (F1 + F2)
Ship workspace CLI + MCP resources. Extends connector smoke.

### Milestone 3.2 — Safety net (F3 + F4 + F6)
Snapshots, secrets, budgets. Highest trust unlock.

### Milestone 3.3 — Human UX (F5 + F7)
Control UI + SSE streaming.

### Milestone 3.4 — Stretch (F8–F10)
Devices tools, plugins, doctor watch.

---

## 7. Success metrics

Wave 3 is “done” when:

1. A new user can `workspace use` a repo and an MCP playground agent completes a multi-step edit **without** leaving that tree.
2. `resources/read deckagent://audit/recent` shows the same events as `audit.jsonl`.
3. User can undo an agent edit via `restore_snapshot` in &lt;2 tool calls.
4. A secret can be used in a command without appearing in audit or model-visible tool output.
5. Hitting a budget returns a clear `BUDGET_EXCEEDED` instead of runaway disk/CPU use.
6. Approving a tool from `http://127.0.0.1:9150` works without reading terminal logs.

---

## 8. Open questions

1. Should workspace root auto-add itself to `allowed_directories`, or require an explicit policy edit?
2. SSE streaming: support only `execute_command_stream`, or also browser screenshot chunking later?
3. Control UI: plain HTML now vs minimal Vite app (prefer plain HTML for daemon simplicity)?
4. Snapshots: store under workspace `.deckagent/` vs global `~/.deckagent/snapshots/`? (Spec currently global.)

**Defaults if unanswered:** auto-add workspace to allowlist on `workspace use`; SSE for stream tool only; plain HTML UI; global snapshot dir.

---

## 9. Out of scope reminders

Do not block Wave 3 on: gpt4free integrations, Chrome Web Store publish, OAuth App flows for ChatGPT, or rewriting the v2 extension adapters.
