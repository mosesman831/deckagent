# DeckAgent — Wave 5 Operator Experience Spec

> Status: **SPEC → IMPLEMENT**  
> Goal: Ship the highest-leverage post-hardening features: first-run confidence, safer approvals, device control, background jobs, plugin integrity, and a real MCP/curl smoke path.  
> Assumes Waves 2–4, F1–F10, and production P0–P2 are complete.

---

## 0. What we chose (and why)

| ID | Feature | Why it’s “best next” |
|----|---------|----------------------|
| **W5.1** | `deckagent onboard` | Turns “installed” into “proven working” in one command |
| **W5.2** | `deckagent smoke` | Operator-facing MCP/curl matrix without digging into worker scripts |
| **W5.3** | Diff preview on confirmations | Biggest trust unlock for `write_file` / `edit_file` |
| **W5.4** | Device revoke (CLI + Control UI) | Stolen/old device cleanup without full uninstall |
| **W5.5** | Background jobs | Long builds without blocking MCP request lifetime |
| **W5.6** | Plugin integrity (`sha256`) | Stop silent plugin file swaps |
| **W5.7** | Ops alerts | Notify on budget hit + tunnel disconnect |
| **W5.8** | Live E2E harness | `scripts/live-mcp-e2e.mjs` starts local stack and curls `/mcp` |

### Explicitly deferred
- Chrome Web Store publish, OAuth App flow, multi-tenant SaaS, full computer-use GUI suite, signed pkg/msi.

---

## 1. Non-negotiables

Same as AGENTS.md: build order mcp-server → worker → daemon → cli; Zod; human errors; policy in daemon; JSON-line WS; `~/.deckagent` config; no sudo; logs 10MB×5; every tool/command tested.

---

## 2. Detailed feature specs

### W5.1 — `deckagent onboard`

**CLI:** `deckagent onboard [--skip-smoke] [--json]`

**Steps (print checklist):**
1. Config exists + parses (`config.json`)
2. Policy exists; warn if `trusted_directories` empty
3. Daemon PID alive (`daemon.pid`) + `health.json` fresh
4. Worker `GET {worker_url}/health` → 200
5. MCP `initialize` with Bearer `api_token` → ok
6. Unless `--skip-smoke`: run compact smoke (W5.2 core subset)
7. Print next actions: `deckagent ui`, connector URL `…/mcp`, `deckagent workspace use .`

**Exit:** `0` all green; `1` any failed check.

**Tests:** unit with mocked fetch/fs; exit codes.

---

### W5.2 — `deckagent smoke`

**CLI:** `deckagent smoke [--profile mcpplayground|cursor|claude-desktop] [--base-url URL] [--token TOKEN]`

Defaults: read `worker_url` + `api_token` from config.

**Matrix (reuse / wrap `packages/cloudflare-worker/scripts/connector-smoke.ts` logic or call it):**
1. `initialize`
2. `tools/list` (expect ≥ 15 tools when daemon online; static ok if offline)
3. `resources/list` + read `deckagent://about` or `deckagent://devices`
4. `prompts/list`
5. If daemon online: `tools/call` `get_environment` and `list_directory` with `"."` if workspace set else a trusted path
6. Optional SSE: `execute_command_stream` with `echo deckagent-smoke` when Accept SSE

**Output:** PASS/FAIL per step; non-zero on failure.

**Also expose:** `npm run smoke --workspace=packages/cloudflare-worker` remains; CLI is the user-facing entry.

**Tests:** mock Worker responses; live path covered by W5.8.

---

### W5.3 — Diff preview on confirmations

**When:** tools `write_file`, `edit_file` (and optionally `restore_snapshot`).

**Daemon:**
1. Extend pending approval object:
   ```ts
   {
     id, tool, reason, argsSummary, createdAt,
     diff?: { path: string; language?: string; before: string; after: string; unified: string }
   }
   ```
2. Before `createApproval`, if write/edit:
   - Resolve path (workspace-aware)
   - Read current file if exists (cap 200KB; else mark truncated)
   - Compute unified diff (simple line diff; dependency-free preferred)
   - Store `diff.unified` capped to ~20KB for UI
3. Confirmation HTML (`:9148`) and Control UI (`:9150`):
   - Render `<pre class="diff">` with unified diff when present
   - Keep redacted argsSummary for non-diff tools

**Security:** never include secret vault values; redact lines matching `API_KEY|TOKEN|SECRET` patterns in diff text.

**Tests:** edit_file confirmation includes `@@` hunk; write new file shows `+` lines.

---

### W5.4 — Device revoke

**CLI:**
```
deckagent device list
deckagent device revoke <device_id> [--yes]
deckagent device prefer|clear  # existing
```

`revoke` → `DELETE /api/devices/:id` with Bearer (already exists on Worker). If revoking **self** (`config.device_id`), require `--yes` and warn daemon will lose registration until re-setup.

**Control UI:**
- Section “Devices” on dashboard: fetch from Worker if possible **or** show local device + preferred id from config
- Practical approach (loopback, no CORS to worker sometimes): CLI-less — daemon exposes `GET /api/local/device` (local config) and `POST /api/local/device/revoke` that calls Worker DELETE using config credentials
- Button “Revoke on Worker” with UI token auth

**Tests:** revoke calls DELETE; self-revoke without `--yes` refused.

---

### W5.5 — Background jobs

**New MCP tools** (mcp-server + worker catalog + daemon policy):

| Tool | Args | Behavior |
|------|------|----------|
| `start_job` | `command`, `cwd?`, `timeout_ms?` (default 30m cap) | Spawn detached tracked job; return `{ job_id }` immediately |
| `list_jobs` | `status?` | List jobs |
| `get_job` | `job_id`, `tail_lines?` | Status + stdout/stderr tail |
| `cancel_job` | `job_id` | SIGTERM then SIGKILL |

**Storage:** `~/.deckagent/jobs/<job_id>/` with `meta.json`, `stdout.log`, `stderr.log`.

**Policy:**
- Same command policy as `execute_command`
- Default `require_confirmation` includes `start_job`, `cancel_job`
- Budgets: count as shell seconds when running
- Caps: max 5 concurrent jobs; max log 5MB per stream

**Catalog:** add to TOOL_CATALOG; capability = terminal.

**Tests:** start `echo hi`, get_job sees output; cancel long `sleep`.

---

### W5.6 — Plugin integrity

**Manifest optional field:**
```json
{ "integrity": { "sha256": "<hex of entry file contents>" } }
```

**Daemon load:**
- If `integrity.sha256` present → hash entry file; mismatch → skip plugin + log `PLUGIN_INTEGRITY_MISMATCH`
- Policy option `require_plugin_integrity: boolean` (default **true** on strict/locked, **false** on dev)
- When require true and hash missing → skip/deny load

**CLI:** `deckagent plugin list` shows integrity ok/missing/mismatch; `deckagent plugin hash <name>` prints sha256 for pinning.

**Tests:** wrong hash skipped; correct hash loads.

---

### W5.7 — Ops alerts

Extend `notify.ts` usage:
1. On tunnel disconnect after connected (tunnel-client): notify “DeckAgent disconnected”
2. On reconnect success after disconnect: notify “DeckAgent reconnected”
3. On `BUDGET_EXCEEDED`: notify with budget name
4. Debounce: max 1 disconnect notify / 60s

**Tests:** call notify hooks with mock (or spy that records); don’t require real OSD bus.

---

### W5.8 — Live MCP E2E harness

**Script:** `scripts/live-mcp-e2e.mjs` + root `npm run e2e:mcp`

**Flow:**
1. Ensure build
2. Start `wrangler dev --local --port 8787` in worker package (background)
3. Write temp config pointing at `http://127.0.0.1:8787` with test API_TOKEN matching `.dev.vars`
4. Start daemon foreground against that worker (or reuse existing if compatible)
5. curl/fetch MCP:
   - POST `/mcp` initialize
   - tools/list
   - tools/call get_environment
   - tools/call list_directory
   - resources/read deckagent://devices (or about)
6. Tear down processes
7. Exit non-zero on any failure

**Also:** document curl examples in SPEC appendix.

If wrangler unavailable: skip with clear message exit 0 **only in CI skip mode** via `DECKAGENT_E2E_SKIP=1`; otherwise fail. Prefer actually running in this agent environment.

**Acceptance note (2026-07-16):** `npm run e2e:mcp` passed locally with Wrangler 4.111.0. Evidence: `/health` 200, device registration 200, daemon tunnel online, MCP `initialize`, `tools/list` (21 tools), `resources/list` (6 resources), `resources/read deckagent://devices`, `tools/call get_environment`, `tools/call list_directory "."`, `tools/call start_job`, and `tools/call get_job` all passed.

---

## 3. Implementation waves (parallel subagents)

### Wave A (parallel)
- **A1:** W5.5 jobs (mcp-server schemas/tools + daemon executor + worker catalog + tests)
- **A2:** W5.3 diff preview (daemon confirmation + control UI + tests)
- **A3:** W5.6 plugin integrity + W5.7 alerts

### Wave B (parallel, after A or overlapping carefully)
- **B1:** W5.1 onboard + W5.2 smoke CLI
- **B2:** W5.4 device revoke CLI + control UI local revoke API
- **B3:** W5.8 live-mcp-e2e script + wire package.json; run it

### Integrator
- Full `npm run build && npm test && security:smoke && pack:smoke`
- Run `deckagent smoke` / live e2e with curl evidence
- Update README Status + CHANGELOG Unreleased
- Commit/push/PR

---

## 4. Curl / MCP test appendix (must pass in e2e)

```bash
# Health
curl -sS "$BASE/health"

# Initialize
curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0.0.1"}}}'

# Tools list
curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Call get_environment
curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_environment","arguments":{}}}'
```

---

## 5. Acceptance checklist

- [ ] `deckagent onboard` exits 0 on healthy local stack
- [ ] `deckagent smoke` passes against live Worker+daemon
- [ ] write/edit confirmation shows unified diff
- [ ] `deckagent device revoke` + UI revoke path work
- [ ] `start_job` / `get_job` / `cancel_job` work end-to-end
- [ ] plugin integrity mismatch refused under strict
- [ ] disconnect/budget alerts invoked (unit-covered)
- [x] `npm run e2e:mcp` green (2026-07-16 local run; see W5.8 acceptance note)
- [ ] All package tests + security:smoke + pack:smoke green

---

## 6. Package impact map

| Package | W5.1 | W5.2 | W5.3 | W5.4 | W5.5 | W5.6 | W5.7 | W5.8 |
|---------|------|------|------|------|------|------|------|------|
| mcp-server | | | | | ✅ | | | |
| worker | | ✅ | | ✅ | ✅ catalog | | | ✅ |
| daemon | | | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| cli | ✅ | ✅ | | ✅ | | ✅ hash | | |
| scripts | | | | | | | | ✅ |
