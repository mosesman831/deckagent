import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyProfileDefaults,
  getPolicyPath,
  policyExists,
  printSecuritySummary,
  readPolicy,
  writePolicy,
  type Policy,
  type SecurityProfile
} from './configure.js';
import { resolveDaemonPaths } from './install-daemon.js';

const VALID_PROFILES = new Set<SecurityProfile>(['strict', 'dev', 'locked']);

/**
 * Expand `~` and resolve to an absolute path (does not require existence).
 */
export function expandPolicyPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Path is required.');
  }

  let expanded: string;
  if (trimmed === '~') {
    expanded = os.homedir();
  } else if (trimmed.startsWith('~/') || trimmed.startsWith('~' + path.sep)) {
    expanded = path.join(os.homedir(), trimmed.slice(2));
  } else {
    expanded = path.resolve(trimmed);
  }

  return path.resolve(expanded);
}

function normalizeForCompare(inputPath: string): string {
  let normalized = path.resolve(inputPath);
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  if (normalized.length > 1 && (normalized.endsWith(path.sep) || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function listIncludes(list: string[], candidate: string): boolean {
  const needle = normalizeForCompare(candidate);
  return list.some((entry) => normalizeForCompare(entry) === needle);
}

/**
 * Add a path to trusted_directories and allowed_directories (compat alias).
 */
export function addTrustedDirectory(
  policy: Policy,
  inputPath: string
): { policy: Policy; path: string; added: boolean } {
  const absPath = expandPolicyPath(inputPath);
  const trusted = [...policy.trusted_directories];
  const allowed = [...policy.allowed_directories];
  let added = false;

  if (!listIncludes(trusted, absPath)) {
    trusted.push(absPath);
    added = true;
  }
  if (!listIncludes(allowed, absPath)) {
    allowed.push(absPath);
    added = true;
  }

  return {
    path: absPath,
    added,
    policy: {
      ...policy,
      trusted_directories: trusted,
      allowed_directories: allowed
    }
  };
}

/**
 * Add a path to denied_directories.
 */
export function addDeniedDirectory(
  policy: Policy,
  inputPath: string
): { policy: Policy; path: string; added: boolean } {
  const absPath = expandPolicyPath(inputPath);
  if (listIncludes(policy.denied_directories, absPath)) {
    return { policy, path: absPath, added: false };
  }
  return {
    path: absPath,
    added: true,
    policy: {
      ...policy,
      denied_directories: [...policy.denied_directories, absPath]
    }
  };
}

export function applySetProfile(policy: Policy, profile: SecurityProfile): Policy {
  if (profile === 'locked') {
    return {
      ...policy,
      profile: 'locked',
      profile_locked: true
    };
  }

  const next = applyProfileDefaults(profile, {
    ...policy,
    profile,
    profile_locked: false,
    trusted_directories:
      policy.trusted_directories.length > 0
        ? policy.trusted_directories
        : policy.allowed_directories,
    allowed_directories:
      policy.allowed_directories.length > 0
        ? policy.allowed_directories
        : policy.trusted_directories
  });

  return {
    ...policy,
    ...next,
    profile,
    profile_locked: false
  } as Policy;
}

function requirePolicy(): Policy {
  if (!policyExists()) {
    throw new Error(`Policy not found at ${getPolicyPath()}. Run 'deckagent setup' first.`);
  }
  return readPolicy();
}

async function createUnlockTokenViaDaemon(): Promise<{
  token: string;
  expires_at: string;
}> {
  const { packageDir } = resolveDaemonPaths();
  const modPath = path.join(packageDir, 'dist', 'src', 'policy-lock.js');
  if (!fs.existsSync(modPath)) {
    throw new Error(
      `Could not load policy-lock from desktop-daemon (${modPath}). Build packages/desktop-daemon first.`
    );
  }
  const mod = (await import(pathToFileURL(modPath).href)) as {
    createUnlockToken: (baseDir?: string) => { token: string; expires_at: string };
  };
  return mod.createUnlockToken();
}

function printPolicyHelp(): void {
  console.log(`Usage:
  deckagent policy show
  deckagent policy set-profile <strict|dev|locked>
  deckagent policy trust <path>
  deckagent policy deny <path>
  deckagent policy lock
  deckagent policy unlock
`);
}

export function policyShow(): void {
  const policy = requirePolicy();
  printSecuritySummary(policy);
  console.log(JSON.stringify(policy, null, 2));
}

export function policySetProfile(profileRaw: string): void {
  const profile = profileRaw.trim().toLowerCase() as SecurityProfile;
  if (!VALID_PROFILES.has(profile)) {
    throw new Error(`Invalid profile "${profileRaw}". Use: strict | dev | locked`);
  }
  const current = requirePolicy();
  const updated = applySetProfile(current, profile);
  writePolicy(updated);
  console.log(`Profile set to "${profile}".`);
  printSecuritySummary(updated);
}

export function policyTrust(inputPath: string): void {
  const current = requirePolicy();
  const { policy, path: absPath, added } = addTrustedDirectory(current, inputPath);
  if (!fs.existsSync(absPath)) {
    fs.mkdirSync(absPath, { recursive: true });
  }
  writePolicy(policy);
  console.log(
    added ? `Trusted directory added: ${absPath}` : `Already trusted: ${absPath}`
  );
}

export function policyDeny(inputPath: string): void {
  const current = requirePolicy();
  const { policy, path: absPath, added } = addDeniedDirectory(current, inputPath);
  writePolicy(policy);
  console.log(
    added ? `Denied directory added: ${absPath}` : `Already denied: ${absPath}`
  );
}

export function policyLock(): void {
  const current = requirePolicy();
  const updated: Policy = {
    ...current,
    profile_locked: true
  };
  writePolicy(updated);
  console.log('Policy locked. Control UI cannot change policy without an unlock token.');
}

export async function policyUnlock(): Promise<void> {
  requirePolicy();
  const record = await createUnlockTokenViaDaemon();
  console.log('Unlock token created (TTL 5 minutes, one-time use).');
  console.log(`Token: ${record.token}`);
  console.log(`Expires: ${record.expires_at}`);
  console.log(
    'Send header X-DeckAgent-Unlock with this token to POST /api/policy or /api/policy/unlock.'
  );
  console.log('This does not clear profile_locked until the Control UI validates the token.');
}

export async function runPolicyCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printPolicyHelp();
    return;
  }

  switch (sub) {
    case 'show':
      policyShow();
      break;
    case 'set-profile': {
      const profile = args[1];
      if (!profile) {
        throw new Error(
          'Missing profile. Usage: deckagent policy set-profile <strict|dev|locked>'
        );
      }
      policySetProfile(profile);
      break;
    }
    case 'trust': {
      const p = args[1];
      if (!p) {
        throw new Error('Missing path. Usage: deckagent policy trust <path>');
      }
      policyTrust(p);
      break;
    }
    case 'deny': {
      const p = args[1];
      if (!p) {
        throw new Error('Missing path. Usage: deckagent policy deny <path>');
      }
      policyDeny(p);
      break;
    }
    case 'lock':
      policyLock();
      break;
    case 'unlock':
      await policyUnlock();
      break;
    default:
      throw new Error(
        `Unknown policy command: ${sub}. Use: show | set-profile | trust | deny | lock | unlock`
      );
  }
}
