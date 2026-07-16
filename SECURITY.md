# Security Policy

DeckAgent gives a remote AI **shell and filesystem access** on your machine through a self-hosted bridge. Treat the API token and device token like root credentials for your user account.

## Supported versions

Security fixes are applied on the latest `main` branch.

## Reporting a vulnerability

Please open a private GitHub Security Advisory for this repository. Do not file public issues for exploitable flaws until a fix is available.

## Current security status

Wave 4 hard security enforcement is implemented in the daemon policy engine. The daemon, not the Worker, enforces security profiles, capability gates, trusted/denied/protected path rules, read-only mode, command policy, browser host policy, policy lock behavior, confirmations, and audit logging.

The Worker and MCP connector authentication model is Bearer-token only. DeckAgent does not currently implement OAuth for ChatGPT or other MCP clients; rotate leaked Worker tokens with `deckagent token rotate` and then update the Worker `API_TOKEN` secret and every connector.

## Hardening checklist (operators)

1. Keep `~/.deckagent/config.json` and `policy.json` mode `0600`.
2. Prefer a narrow `allowed_directories` / trusted project root over `~`.
3. Leave `require_confirmation` enabled for mutating tools; approvals open only on `127.0.0.1`.
4. Enable `read_only: true` when you only need inspection (daemon hard-blocks writers/terminal).
5. Rotate `API_TOKEN` (Worker secret) and device tokens if they leak. Use `deckagent token rotate` for the Worker Bearer token; add `--deploy` to update the Worker secret through Wrangler when available.
6. Browser tools require `allow_browser: true` (or `deckagent-daemon --enable-browser`) and a local Playwright Chromium install.
7. The v2 extension talks only to `127.0.0.1:9147` — do not expose that port.
8. Terminal allowlists are command-name filters, not sandboxes. Interpreters such as `python`, `node`, `perl`, and `ruby` can run arbitrary code with inline flags (`-c`, `-e`, `--eval`); DeckAgent blocks those inline forms under strict/allowlist unless `terminal_mode` is `sandbox_fs`.
9. Custom plugins are local code execution. Keep `allow_plugins=false` unless you trust every plugin author and every plugin file under `~/.deckagent/plugins/`.
10. `terminal_mode=sandbox_fs` needs a supported OS sandbox binary. On Linux that means `bwrap`; without it, sandbox mode fails closed with `TERMINAL_SANDBOX_UNAVAILABLE`.
11. The local control UI is loopback-only and token-protected. Open it with `deckagent ui`; protect `~/.deckagent/ui.token` like a local session secret.

## Residual risks

- A stolen Bearer token can invoke the exposed Worker until rotated, subject to daemon policy and online device availability.
- Plugins run trusted local code in an isolated child process, but they are not an untrusted-code sandbox.
- Shell allowlists reduce accidental command use but do not provide filesystem containment; use `sandbox_fs` where actual shell containment is required.
- Browser automation executes inside a local Playwright browser and can interact with allowed hosts as the local user.
- Anyone with access to the same OS user account can read local DeckAgent config unless filesystem permissions are preserved.

For the implemented hardening wave details (profiles, protected paths, tools/list filtering, symlink policy), see [`docs/SECURITY_ENFORCEMENT_SPEC.md`](docs/SECURITY_ENFORCEMENT_SPEC.md).
