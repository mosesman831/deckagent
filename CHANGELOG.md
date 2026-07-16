# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `deckagent token rotate [--deploy]` for Worker Bearer token rotation.
- Canonical `SPEC.md` index and refreshed operator security/readiness docs.

## [0.2.0] - 2026-07-16

### Added

- Wave 2 production foundations for the self-hosted bridge, including auditability, allowlist-first operator posture, packaging readiness, and connector prompts.
- Wave 3 F1-F10 daily-driver features: workspaces, MCP resources, edit snapshots and restore, secrets vault, local control UI, budgets, SSE command progress, device discovery and preference, custom plugins, and daemon health/watchdog support.
- Wave 4 hard security enforcement: strict/dev/locked profiles, capability-based tool filtering, trusted/denied/protected path policy, read-only hard gates, path canonicalization, terminal containment modes, browser/network egress controls, policy lock, and sensitive path defaults.
- Production readiness P0 hardening: real `sandbox_fs` wrapping, restore target policy re-checks, fail-closed strict defaults, publishable public packages, and loopback CSRF/UI token protections.
- Production readiness P1 hardening: plugin child-process isolation, browser host enforcement, soft MCP policy errors, Worker rate limiting, daemon protocol compatibility handling, safer uninstall flows, 10MB x 5 log/audit rotation, Zod validation on device APIs, CI pack smoke checks, and strict allowlist documentation.
- Production readiness P2 release workflow and changelog groundwork. Metrics, token rotation CLI, and best-effort abort handling remain outside the 0.2.0 release notes.

### Changed

- Public package versions are aligned at `0.2.0` for `@deckagent/mcp-server`, `@deckagent/desktop-daemon`, and `@deckagent/cli`.
- Release packaging now follows the required build order: `mcp-server` -> `cloudflare-worker` -> `desktop-daemon` -> `cli`.

[Unreleased]: https://github.com/mosesman831/deckagent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mosesman831/deckagent/releases/tag/v0.2.0
