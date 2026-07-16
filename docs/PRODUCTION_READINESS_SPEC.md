# DeckAgent — Production Readiness Spec (P0–P2)

> Status: **SPEC → IMPLEMENT**  
> Goal: Close remaining gaps so DeckAgent is honestly “production-ready” for self-hosted operators.  
> Assumes Waves 2–4 and F1–F10 are already on branch.

---

## 0. Scope & principles

### In scope
All **P0 / P1 / P2** items from the production audit. Fully implement (not stub).

### Out of scope
- Multi-tenant SaaS / billing
- ChatGPT OAuth App flows
- Chrome Web Store publish of v2 extension
- Replacing Playwright

### Non-negotiable rules (AGENTS.md)
1. Build order: mcp-server → cloudflare-worker → desktop-daemon → cli  
2. Zod everywhere; no `any`  
3. Human-readable errors  
4. Policy in daemon, not Worker  
5. WebSocket JSON-lines  
6. Config in `~/.deckagent/*.json` (no new user env vars)  
7. No sudo/root  
8. Logs: `~/.deckagent/logs/`, **10MB rotation, keep 5**  
9. Every new behavior gets tests / smoke  

### Definition of “production ready”
1. Defaults are least-privilege (`strict`) when policy is missing.  
2. Security modes that claim containment actually contain (or fail closed).  
3. Local HTTP mutation endpoints resist CSRF from random websites.  
4. `@deckagent/cli` can be packed and installed from a tarball without `file:` deps.  
5. Policy denials surface as MCP tool errors clients can read.  
6. Docs match reality; CI proves pack + rotation + security smoke.  
7. Operator can uninstall cleanly and observe health/version compatibility.

---

## 1. Work item index

| ID | Priority | Title | Packages |
|----|----------|-------|----------|
| PR0.1 | P0 | Real `sandbox_fs` execution (or refuse) | mcp-server, daemon |
| PR0.2 | P0 | `restore_snapshot` re-checks target path policy | daemon, mcp-server |
| PR0.3 | P0 | Missing-policy defaults → `strict` fail-closed | daemon, cli |
| PR0.4 | P0 | Publishable packages (`file:` → workspace versions) | root, cli, daemon, mcp-server |
| PR0.5 | P0 | Loopback CSRF + no GET mutate + UI auth token | daemon |
| PR1.1 | P1 | Plugin child-process isolation | daemon |
| PR1.2 | P1 | Browser host enforcement (navigate/redirect/route) | daemon, mcp-server |
| PR1.3 | P1 | Soft MCP errors for all policy/budget codes | worker (+ assets) |
| PR1.4 | P1 | Worker rate limit on `/mcp` + device APIs | worker |
| PR1.5 | P1 | Honor `auth_ok` version/warnings in daemon + doctor | daemon, cli |
| PR1.6 | P1 | Uninstall: dry-run, device unregister, safer deletes | cli |
| PR1.7 | P1 | Log + audit rotation = 10MB × keep 5 | daemon |
| PR1.8 | P1 | Zod-validate Worker device register/prefer APIs | worker |
| PR1.9 | P1 | CI: `npm ci`, pack dry-run, asset sync check | CI, scripts |
| PR1.10 | P1 | Strict allowlist docs + deny bare interpreters without sandbox | daemon, docs |
| PR2.1 | P2 | Canonical `SPEC.md` + README/SECURITY sync | docs |
| PR2.2 | P2 | Metrics counters (local + Worker lightweight) | daemon, worker |
| PR2.3 | P2 | Release workflow + CHANGELOG | CI, docs |
| PR2.4 | P2 | Token rotation / Bearer-only operator guide | docs, cli |
| PR2.5 | P2 | Abort signal for long tools (best-effort) | daemon, mcp-server |

---

## 2. Detailed specs

### PR0.1 — Real `sandbox_fs`

**Problem:** Policy only checks that `bwrap`/`sandbox-exec` exists; `runShellCommand` still uses raw `spawn(shell:true)`.

**Design:**
1. Add `packages/mcp-server/src/tools/terminal-sandbox.ts`:
   - `buildSandboxCommand(opts)` → `{ argv: string[], env?: Record }`
   - Linux: `bwrap --ro-bind /usr /usr --ro-bind /lib /lib … --bind <trustedWrite> <trustedWrite> --chdir <cwd> --deadend /proc --unshare-net? -- /bin/sh -c <cmd>`
   - Keep mounts minimal: bind trusted dirs RW; bind system paths RO; do **not** bind `/home` wholesale unless trusted.
   - macOS: `sandbox-exec -f <profile>` with profile allowing only trusted paths (generate temp `.sb` file under `~/.deckagent/tmp`).
2. Daemon `checkCommandPolicy` when `terminal_mode=sandbox_fs`:
   - If no binary → `TERMINAL_SANDBOX_UNAVAILABLE` (unchanged).
   - Else attach `_sandbox: { binary, trusted_dirs, network: false }` onto execution context (not model-visible args).
3. `tool-executor` / terminal tools:
   - When sandbox plan present, call sandboxed spawn instead of raw shell.
4. Network: under `sandbox_fs`, default **no network** (`--unshare-net` on bwrap when available). Shell net tools already blocked by policy when `block_shell_net_tools`.

**Tests:**
- Without binary → deny.
- With mocked/fake `bwrap` that records argv → assert command wrapped.
- Smoke: if real bwrap present, `echo hi` succeeds under sandbox.

**Acceptance:** Impossible to run `terminal_mode=sandbox_fs` via unwrapped `spawn(shell:true)`.

---

### PR0.2 — `restore_snapshot` path re-check

**Problem:** Only `id` is policy-checked; restore writes `meta.path` unchecked.

**Design:**
1. In daemon `ToolExecutor` before execute (or in `checkPathAllowed` special-case):
   - For `restore_snapshot`, load snapshot metadata by id from snapshots dir.
   - Run write-path evaluation on `meta.path` (trusted/denied/protected/workspace).
   - If missing snapshot → `NOT_FOUND` human message.
2. mcp-server `restore_snapshot` remains the writer; daemon gates it.

**Tests:** Snapshot whose `meta.path` is under `~/.ssh` → `PATH_PROTECTED` / denied; trusted path → ok.

---

### PR0.3 — Fail-closed default policy

**Problem:** Missing `policy.json` writes `profile: "dev"`, `allowed_directories: ["~"]`, plugins on.

**Design:**
1. Change Zod / `createDefaultPolicy()` to:
   - `profile: "strict"`
   - `allowed_directories: []` (or home only if we must — prefer empty + require setup; if empty blocks all FS, document that `deckagent setup` / `policy trust` is required)
   - `allow_plugins: false`
   - `allow_secret_injection: false`
   - `terminal_mode: "allowlist"`
   - `command_mode: "allowlist"`
   - `allowed_commands`: same as CLI `DEFAULT_STRICT_ALLOWED_COMMANDS`
   - `network.block_shell_net_tools: true`
   - `protected_path_policy: "deny_all"`
2. Align CLI `configure.ts` defaults with daemon (single comment pointing to shared list; duplicate values OK if shared module is hard across packages — prefer export from a tiny shared constants file in mcp-server or duplicate with test asserting parity).
3. `readPolicy()` when creating default: log warn `"Created strict default policy at …; run deckagent policy trust <dir>"`.

**Tests:** Fresh temp HOME → default profile strict, plugins false, allowlist terminal.

---

### PR0.4 — Publishable packages

**Problem:** `file:` deps break `npx`/npm install for outsiders.

**Design:**
1. Set versions consistently to `0.2.0` across `@deckagent/mcp-server`, `@deckagent/desktop-daemon`, `@deckagent/cli` (worker stays private / not published).
2. Replace `"file:../…"` with `"workspace:*"` for local monorepo **OR** `"^0.2.0"` + document publish order.
   - Prefer: `"@deckagent/mcp-server": "0.2.0"` style with npm workspaces (npm 7+ resolves workspace packages).
3. Mark `packages/cloudflare-worker` `"private": true`.
4. Root stays private; README install becomes:
   ```bash
   npm install -g @deckagent/cli
   # or
   npx @deckagent/cli setup
   ```
5. Add `scripts/pack-smoke.mjs`:
   - `npm pack` each public package in order (mcp-server → daemon → cli)
   - Install cli tarball into a temp dir with offline/from-tarball deps and run `--help`
6. CI runs pack smoke.

**Acceptance:** From clean temp dir, install packed tarballs without monorepo checkout; `deckagent --help` works.

---

### PR0.5 — Local HTTP CSRF / mutation hardening

**Problem:** GET approve; unauthenticated Control UI POSTs; no Origin checks.

**Design:**
1. **Confirmation server (`:9148`):**
   - Reject GET for `/confirm/:id/approve|deny` with `405` + HTML saying use the form.
   - Issue CSRF token per approval in memory; embed as hidden field `csrf` in HTML form; require matching POST body/header.
   - Validate `Host` is loopback (`127.0.0.1` / `localhost`) and `Origin`/`Referer` (if present) is loopback.
2. **Control UI (`:9150`):**
   - On start, generate `~/.deckagent/ui.token` (32+ random bytes hex), mode `0600`.
   - All mutating routes require header `X-DeckAgent-UI-Token` OR cookie set by UI after `?token=` bootstrap once.
   - Serve UI with cookie `Set-Cookie: deckagent_ui=<token>; HttpOnly; SameSite=Strict; Path=/` when valid token query provided.
   - Reject cross-origin POSTs (Origin must be `http://127.0.0.1:9150` or missing for same-origin curl with header).
3. CLI `deckagent ui` opens `http://127.0.0.1:9150/?token=<ui.token>`.

**Tests:** GET approve → 405; POST without csrf → 403; control UI POST without token → 401.

---

### PR1.1 — Plugin isolation

**Design:**
1. Execute plugins via `child_process.fork` (or `worker_threads`) with:
   - timeout = `max_command_timeout`
   - env stripped to `PATH`, `HOME`, `TMPDIR` only (no secrets file contents)
   - message protocol: `{ type:"run", args }` → `{ type:"result", result }` / `{ type:"error", message }`
2. Loader still validates path under plugins root; **import runs in child**, not parent.
3. Parent registers a stub handler that RPCs to child.
4. Default `allow_plugins: false` (via PR0.3).

**Tests:** Plugin that tries `process.exit` / reads env — assert secrets not present; timeout kills child.

---

### PR1.2 — Browser host enforcement

**Design:**
1. Fix evaluate arg bug (`code` not `expression`) for any static URL extract (optional keep).
2. In mcp-server browser module, accept optional `hostPolicy` callback / global setter from daemon:
   - `setBrowserHostPolicy({ allow, deny, onNavigate })`
3. On browser context creation, attach:
   - `page.on('framenavigated')` / `context.on('page')` deny + abort if host not allowed
   - `context.route('**/*', …)` abort requests to denied hosts
4. Daemon sets policy from `network.allow_browser_hosts` / `deny_browser_hosts` before execute.

**Tests:** deny host blocks navigate and redirect; allow host works.

---

### PR1.3 — Soft MCP tool errors

**Design:**
1. Expand soft-error set in `tunnel-do.ts` (and CLI assets copy) to include:
   `READ_ONLY`, `TOOL_DISABLED`, `NETWORK_DENIED`, `TERMINAL_SANDBOX_UNAVAILABLE`,
   `PATH_UNTRUSTED`, `PATH_DENIED`, `PATH_PROTECTED`, `BUDGET_EXCEEDED`,
   `PROFILE_LOCKED`, `NOT_FOUND`, `PLUGIN_DENIED`, `DEVICE_*` (as applicable).
2. Prefer shared constant array `SOFT_TOOL_ERROR_CODES` in worker `errors.ts`.

**Tests:** Mock daemon soft error with `PATH_PROTECTED` → MCP result `isError: true`, not JSON-RPC 500.

---

### PR1.4 — Worker rate limiting

**Design:**
1. Simple in-memory / DO / KV sliding window per API token hash:
   - Default: 120 req/min for `/mcp`, 30 req/min for `/api/devices*`
2. On exceed → HTTP 429 + `{ code: "RATE_LIMITED", message }`
3. Document limits in SPEC; make constants at top of module (Worker has no user config file — constants OK; optional `env.RATE_LIMIT_RPM`).

**Tests:** Burst requests → 429.

---

### PR1.5 — `auth_ok` handling

**Design:**
1. Parse `auth_ok` Zod schema in tunnel-client.
2. If `min_protocol_version` > local → disconnect with clear error.
3. If warning present → log warn; store on health.json (`worker_version`, `protocol_warning`).
4. Doctor prints compatibility line.

**Tests:** Fake auth_ok with high min version → client errors; warning appears in health.

---

### PR1.6 — Safer uninstall

**Design:**
1. `deckagent uninstall [--keep-config] [--keep-logs] [--delete-worker] [--unregister-device] [--yes]`
2. Default interactive confirm listing what will be deleted.
3. `--unregister-device`: DELETE `/api/devices/:id` with bearer.
4. Never wipe secrets/snapshots without explicit confirm unless `--yes` after listing paths.
5. Dry-run mode `--dry-run` prints plan and exits 0.

**Tests:** dry-run does not delete; unregister mocked.

---

### PR1.7 — Rotation 10MB × 5

**Design:**
1. Fix logger cleanup to match rotated names `*.log.<timestamp>`.
2. Audit log: rotate at 10MB; keep `audit.jsonl.1` … `audit.jsonl.5` (or timestamp, keep 5).
3. Tests create many rotated files → assert ≤5 retained.

---

### PR1.8 — Device API Zod validation

**Design:**
1. `DeviceRegisterSchema`: `device_id` uuid, `token` min 32, `name` 1–128, `capabilities` string[].
2. Prefer schema: uuid device_id.
3. Invalid → 400 `INVALID_ARGUMENTS` human message.

---

### PR1.9 — CI hardening

**Design:**
1. Prefer `npm ci` when lockfile present.
2. Add pack-smoke job/step.
3. Add `node scripts/check-worker-assets.mjs` ensuring `packages/cli/assets/worker/src` matches `packages/cloudflare-worker/src` (or is generated by bundle script).
4. Keep security:smoke.

---

### PR1.10 — Allowlist residual risk

**Design:**
1. Document in SECURITY.md that `python`/`node` on allowlist can still run arbitrary code unless `sandbox_fs`.
2. Optional harden: when `terminal_mode=allowlist` and command matches interpreter with `-c`/`-e`/`eval`, require confirmation or deny with `COMMAND_BLOCKED` message pointing to sandbox_fs.
3. Implement deny for `python -c`, `node -e`, `perl -e`, `ruby -e` under strict profile unless sandbox_fs.

---

### PR2.1 — Docs sync

**Design:**
1. Create `/workspace/SPEC.md` as canonical index linking protocols + security + wave specs + this doc.
2. README: Implemented vs Experimental vs Planned; fix `npx @deckagent/cli`.
3. SECURITY.md: update Wave 4 status; list residual risks; add reporting contact placeholder `security@` or GitHub Security Advisories.

---

### PR2.2 — Metrics

**Design:**
1. Daemon `~/.deckagent/metrics.json` updated periodically: counters for tool_ok, tool_denied_by_code, confirmations, reconnects.
2. Control UI `/api/metrics` (auth token required).
3. Worker: optional counters in DO stub memory exposed on authenticated `/metrics` (Bearer) — keep lightweight.

---

### PR2.3 — Release workflow

**Design:**
1. `CHANGELOG.md` Keep-a-Changelog format with Unreleased + 0.2.0 notes.
2. `.github/workflows/release.yml` on tag `v*` → pack + upload artifacts (npm publish only if `NPM_TOKEN` secret present; otherwise artifacts only).

---

### PR2.4 — Token rotation guide

**Design:**
1. Docs section + CLI `deckagent token rotate` that regenerates `api_token` in config, prints wrangler secret set instructions, updates local config.
2. Does not auto-deploy unless `--deploy`.

---

### PR2.5 — Abort signal (best-effort)

**Design:**
1. Pass `AbortSignal` into terminal execute and browser navigate; kill child / page on abort.
2. Filesystem search: check signal between ripgrep batches if feasible; otherwise document best-effort.

---

## 3. Implementation waves (subagents)

### Wave A — P0 (parallel)
- **Agent A1:** PR0.1 + PR0.2 + PR0.3 (+ PR1.10 interpreter harden)
- **Agent A2:** PR0.5 CSRF/UI token
- **Agent A3:** PR0.4 publishability + pack-smoke script

### Wave B — P1 (parallel after A merges)
- **Agent B1:** PR1.3 + PR1.4 + PR1.8 (worker)
- **Agent B2:** PR1.1 + PR1.2 + PR1.5 (daemon)
- **Agent B3:** PR1.6 + PR1.7 + doctor/health bits leftover
- **Agent B4:** PR1.9 CI

### Wave C — P2 (parallel)
- **Agent C1:** PR2.1 docs + PR2.4 token guide/CLI
- **Agent C2:** PR2.2 metrics + PR2.5 abort
- **Agent C3:** PR2.3 release workflow + CHANGELOG

---

## 4. Test matrix (must pass before “done”)

| Check | Command |
|-------|---------|
| Build order | `npm run build` |
| Unit/smoke | `npm test` + extension if touched |
| Security | `npm run security:smoke` |
| Pack | `node scripts/pack-smoke.mjs` |
| CSRF | new daemon tests |
| Soft errors | worker tests |
| Rotation | daemon logger/audit tests |

---

## 5. Acceptance checklist

- [ ] `sandbox_fs` never uses bare shell spawn
- [ ] restore path policy enforced
- [ ] missing policy → strict
- [ ] pack-smoke green
- [ ] GET confirm approve → 405; UI mutations need token
- [ ] plugins run in child process
- [ ] browser route host deny works
- [ ] PATH_PROTECTED is soft MCP error
- [ ] rate limit returns 429
- [ ] auth_ok warning in health + doctor
- [ ] uninstall --dry-run safe
- [ ] logs/audit keep ≤5 rotated @10MB
- [ ] device API Zod validated
- [ ] CI uses ci + pack smoke
- [ ] SPEC.md + README + SECURITY + CHANGELOG accurate
- [ ] metrics endpoint/file exists
- [ ] release workflow present

---

## 6. Rollout notes for operators

After this lands:
1. Re-run `deckagent setup` or `deckagent policy set-profile strict` + `policy trust <project>`.
2. Open UI via `deckagent ui` (tokenized URL).
3. Prefer `terminal_mode=sandbox_fs` on Linux with bwrap installed.
4. Keep `allow_plugins=false` unless you trust every plugin author.
5. Rotate API token periodically (`deckagent token rotate`).
