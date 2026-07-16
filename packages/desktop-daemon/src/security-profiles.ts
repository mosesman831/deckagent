/**
 * Security profiles (S1) + policy normalization (S4/S6/S7).
 * Always run normalizePolicy on read so contradictory JSON cannot leave
 * terminal/browser on while read_only is true.
 */
import type { Policy } from "./policy.js";

/** Safe default allowlist for strict profile terminal commands. */
export const STRICT_ALLOWED_COMMANDS: readonly string[] = [
  "git",
  "npm",
  "node",
  "npx",
  "python",
  "pytest",
  "cargo",
  "go",
  "make",
  "tsc",
  "eslint",
];

/**
 * Apply profile-specific hard defaults without silently widening an already-tight policy.
 * Called as part of normalizePolicy.
 */
export function applyProfileDefaults(policy: Policy): Policy {
  const next: Policy = { ...policy };

  if (next.profile === "locked") {
    next.profile_locked = true;
  }

  if (next.profile === "strict") {
    // command_mode: force allowlist; fill safe defaults if empty
    next.command_mode = "allowlist";
    if (!next.allowed_commands || next.allowed_commands.length === 0) {
      next.allowed_commands = [...STRICT_ALLOWED_COMMANDS];
    }

    // terminal_mode cannot stay blocklist in strict
    if (next.terminal_mode === "blocklist" || !next.terminal_mode) {
      next.terminal_mode = "allowlist";
    }

    next.allow_browser = false;
    next.allow_secret_injection = false;

    // Network: block shell net tools by default in strict
    next.network = {
      ...next.network,
      block_shell_net_tools: true,
      allow_browser_hosts: next.network?.allow_browser_hosts ?? [],
      deny_browser_hosts: next.network?.deny_browser_hosts ?? [],
    };

    // Protected paths: deny read+write in strict
    next.protected_path_policy = "deny_all";

    // trusted_directories: if empty and allowed_directories is ["~"] or empty,
    // leave as-is (migration: trusted falls back to allowed at evaluation time).
    // Document: strict setup should set a single project dir; ~ alone is weak.
  }

  if (next.profile === "dev") {
    // Power-user posture: keep blocklist unless user already chose otherwise.
    // Protected: deny writes only (reads of sensitive paths still possible).
    if (!policy.protected_path_policy) {
      next.protected_path_policy = "deny_write";
    }
  }

  return next;
}

/**
 * Full policy normalization — profile defaults + read_only v2 hard forces.
 * Idempotent. Safe to call on every readPolicy / updatePolicy.
 */
export function normalizePolicy(policy: Policy): Policy {
  let next = applyProfileDefaults({ ...policy });

  // S4 read_only v2: force capability kill switches even if JSON contradicts.
  if (next.read_only) {
    next.allow_terminal = false;
    next.allow_browser = false;
    next.allow_secret_injection = false;
    next.allow_computer_use = false;
    next.terminal_mode = "off";
  }

  // terminal_mode "off" implies allow_terminal false
  if (next.terminal_mode === "off") {
    next.allow_terminal = false;
  }

  // Migration: trusted_directories empty → leave empty (evaluator falls back to allowed_directories)
  if (!next.trusted_directories) {
    next.trusted_directories = [];
  }
  if (!next.denied_directories) {
    next.denied_directories = [];
  }
  if (!next.protected_paths) {
    next.protected_paths = [];
  }

  // Ensure nested defaults exist
  next.path_rules = {
    symlink_mode: next.path_rules?.symlink_mode ?? "deny_escape",
    allow_dotdot: next.path_rules?.allow_dotdot ?? false,
  };
  next.network = {
    allow_browser_hosts: next.network?.allow_browser_hosts ?? [],
    deny_browser_hosts: next.network?.deny_browser_hosts ?? [],
    block_shell_net_tools: next.network?.block_shell_net_tools ?? false,
  };

  if (next.profile === "strict") {
    // Re-assert after merge in case user JSON had block_shell_net_tools: false
    // Spec: strict normalize forces it true (do not silently widen; tightening is OK).
    next.network = { ...next.network, block_shell_net_tools: true };
    next.protected_path_policy = "deny_all";
    next.command_mode = "allowlist";
    if (next.terminal_mode === "blocklist") {
      next.terminal_mode = "allowlist";
    }
    if (!next.allowed_commands || next.allowed_commands.length === 0) {
      next.allowed_commands = [...STRICT_ALLOWED_COMMANDS];
    }
  }

  return next;
}

/**
 * Human-readable warning when raw JSON contradicted effective policy.
 */
export function describeNormalizationFixes(
  before: Policy,
  after: Policy,
): string[] {
  const notes: string[] = [];
  if (before.read_only) {
    if (before.allow_terminal && !after.allow_terminal) {
      notes.push("read_only forces allow_terminal=false");
    }
    if (before.allow_browser && !after.allow_browser) {
      notes.push("read_only forces allow_browser=false");
    }
    if (before.allow_secret_injection && !after.allow_secret_injection) {
      notes.push("read_only forces allow_secret_injection=false");
    }
    if (before.allow_computer_use && !after.allow_computer_use) {
      notes.push("read_only forces allow_computer_use=false");
    }
  }
  if (
    before.profile === "strict" &&
    before.terminal_mode === "blocklist" &&
    after.terminal_mode === "allowlist"
  ) {
    notes.push("strict profile forces terminal_mode=allowlist");
  }
  if (before.profile === "locked" && !before.profile_locked && after.profile_locked) {
    notes.push("profile=locked sets profile_locked=true");
  }
  return notes;
}
