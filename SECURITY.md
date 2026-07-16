# Security Policy

DeckAgent gives a remote AI **shell and filesystem access** on your machine through a self-hosted bridge. Treat the API token and device token like root credentials for your user account.

## Supported versions

Security fixes are applied on the latest `main` branch.

## Reporting a vulnerability

Please open a private security advisory on GitHub, or email the maintainers listed in the repository. Do not file public issues for exploitable flaws until a fix is available.

## Hardening checklist (operators)

1. Keep `~/.deckagent/config.json` and `policy.json` mode `0600`.
2. Prefer a narrow `allowed_directories` / trusted project root over `~`.
3. Leave `require_confirmation` enabled for mutating tools; approvals open only on `127.0.0.1`.
4. Enable `read_only: true` when you only need inspection (daemon hard-blocks writers/terminal).
5. Rotate `API_TOKEN` (Worker secret) and device tokens if they leak.
6. Browser tools require `allow_browser: true` (or `deckagent-daemon --enable-browser`) and a local Playwright Chromium install.
7. The v2 extension talks only to `127.0.0.1:9147` — do not expose that port.
8. Terminal allowlists are command-name filters, not sandboxes. Interpreters such as `python`, `node`, `perl`, and `ruby` can run arbitrary code with inline flags (`-c`, `-e`, `--eval`); DeckAgent blocks those inline forms under strict/allowlist unless `terminal_mode` is `sandbox_fs`.

For the next hardening wave (profiles, protected paths, tools/list filtering, symlink policy), see [`docs/SECURITY_ENFORCEMENT_SPEC.md`](docs/SECURITY_ENFORCEMENT_SPEC.md).
