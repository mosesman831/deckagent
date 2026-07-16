# DeckAgent — Wave 6 Quality & Polish Spec

> Status: **IMPLEMENTED** — Control UI, confirmations, Worker health/errors, catalogs, CLI UX, daemon health, README polished.  
> Goal: Improve every user-facing and agent-facing surface without inventing mega-features. Make the product clearer, safer-feeling, and easier to operate.  
> Assumes Waves 2–5 + production P0–P2 are complete.

---

## 0. Principles

1. **Polish over sprawl** — improve existing flows; no new SaaS/OAuth/computer-use suite.
2. **Consistency** — same `{ code, message, hint? }` shape where practical.
3. **Agent clarity** — tool descriptions + MCP instructions teach recovery paths.
4. **Operator clarity** — UI/CLI show state, next action, and remediation.
5. **Test every change** — unit + keep `e2e:mcp` green.
6. AGENTS.md rules unchanged.

---

## 1. Work items

| ID | Area | Deliverable |
|----|------|-------------|
| **W6.1** | Control UI | Health strip, jobs panel, colored diffs, richer devices, audit table |
| **W6.2** | Confirmation page | Countdown, sticky actions, colored diffs, clearer risk copy |
| **W6.3** | Worker health/errors | Rich `/health`; 401/429 `{code,message,hint,retry_after_seconds}` + `Retry-After` |
| **W6.4** | Tool + prompt catalog | Better tool descriptions; recovery guidance in instructions/prompts |
| **W6.5** | CLI UX | Grouped help; colored onboard/smoke; doctor `--json` + remediation hints |
| **W6.6** | Daemon health | Extra tunnel timing fields in `health.json` |
| **W6.7** | Error consistency | Human messages include actionable `hint` where missing |
| **W6.8** | README | Copy-paste quickstart: setup → onboard → connector → ui → doctor |

---

## 2. Detailed specs

### W6.1 — Control UI (`control-ui.ts`)

1. **Health strip** (top of dashboard): tunnel state, last heartbeat age (e.g. `12s ago`), worker_version, protocol_warning (amber), reconnecting badge.
2. **Jobs panel**: list from `~/.deckagent/jobs/*/meta.json` (newest 20); show id/status/command/started/exit; link or expand stdout/stderr tail (last 40 lines).
3. **Approvals**: color unified diff lines (`+` green, `-` red, `@@` muted); collapse diffs > 40 lines with “Show more”; show expiry countdown; sticky Approve/Deny.
4. **Devices**: show preferred_device_id; fetch Worker devices when possible via daemon proxy `GET /api/local/devices` (daemon uses config bearer to call Worker), else local-only with note.
5. **Audit**: parse NDJSON into table columns: time, tool, outcome/code, duration_ms; simple filter input (client-side).

Preserve UI token auth; loopback only; no new ports.

### W6.2 — Confirmation page (`confirmation-server.ts`)

1. Live expiry countdown (JS `setInterval` on page).
2. Sticky footer with Approve/Deny.
3. Colored diff rows (same scheme as UI).
4. Risk banner text: what approving allows (filesystem write / shell / etc.) based on tool category.
5. Keep CSRF + GET-405 behavior.

### W6.3 — Worker `/health` + auth/rate bodies

`GET /health` JSON:
```json
{
  "status": "ok",
  "worker_version": "...",
  "min_protocol_version": N,
  "started_at": "ISO",
  "uptime_ms": 12345,
  "app_name": "DeckAgent"
}
```

401 body:
```json
{ "code": "UNAUTHORIZED", "message": "...", "hint": "Set Authorization: Bearer <API_TOKEN>" }
```

429 body:
```json
{ "code": "RATE_LIMITED", "message": "...", "hint": "Wait and retry", "retry_after_seconds": 30 }
```
Plus `Retry-After: 30` header.

Mirror into `packages/cli/assets/worker/`.

### W6.4 — Tool descriptions + prompts

Rewrite descriptions (keep schemas) for at least:
- `write_file` / `edit_file` — prefer edit for surgical changes; confirmations may show diffs
- `execute_command` vs `execute_command_stream` vs `start_job` — when to use which
- `list_directory` — use `"."` under workspace
- browser tools — host policy may deny

Prompt/instructions additions:
- DEVICE_OFFLINE → start daemon / `deckagent doctor`
- DEVICE_AMBIGUOUS → `list_devices` / prefer device
- CONFIRMATION_REQUIRED → user must approve on loopback UI
- Long commands → `start_job` then `get_job`
- Stay in workspace; use relative paths

### W6.5 — CLI UX

1. Help grouped: Setup | Operate | Security | Troubleshoot; include examples.
2. `onboard` / `smoke`: section headers, color when TTY (`\x1b`), failed step shows hint + next command.
3. `doctor [--json] [--strict]`: remediation string per failed check; `--strict` exit 1 on failures (one-shot); `--json` emits checks array.

### W6.6 — Daemon health fields

Extend `health.json`:
```json
{
  "connected_at": "ISO|null",
  "last_disconnect_at": "ISO|null",
  "last_disconnect_reason": "string|null",
  "reconnect_attempt": 0,
  "next_reconnect_at": "ISO|null"
}
```
Update tunnel-client on connect/disconnect/backoff. Doctor/onboard may display them.

### W6.7 — Error hints

Where policy denials return messages, append short hints:
- PATH_PROTECTED → “Protected path; choose another file or adjust policy”
- BUDGET_EXCEEDED → “Wait for budget window or raise limits in policy.json”
- DEVICE_OFFLINE → “Run: deckagent daemon --foreground”
Keep codes stable.

### W6.8 — README quickstart

Replace/expand Quick Start with numbered copy-paste:
1. prerequisites  
2. `npx @deckagent/cli setup`  
3. `deckagent onboard`  
4. connector URL + Bearer  
5. `deckagent ui`  
6. `deckagent doctor` / `deckagent smoke`

---

## 3. Parallel build plan

- **Agent A — W6.1 + W6.2** (daemon UI/confirm)
- **Agent B — W6.3 + W6.4** (worker health/errors + catalogs; mirror assets)
- **Agent C — W6.5 + W6.8** (CLI + README)
- **Agent D — W6.6 + W6.7** (health fields + error hints)

Then integrator: build, test, `e2e:mcp`, commit leftovers, push, PR update.

---

## 4. Acceptance

- [x] Control UI shows health strip + jobs + colored diffs + audit table
- [x] Confirmation page has countdown + colored diffs
- [x] `/health` returns version/uptime; 401/429 include hint; 429 has Retry-After
- [x] Tool descriptions mention jobs/workspace/edit guidance
- [x] CLI help grouped; doctor --json works; onboard output structured
- [x] health.json includes reconnect timing fields
- [x] README quickstart updated
- [x] `npm test`, `security:smoke`, `e2e:mcp` green

---

## 5. Out of scope

OAuth, CWS publish, SaaS, signed installers, new MCP tools (except none), redesigning policy engine.
