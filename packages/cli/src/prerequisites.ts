import { execSync } from 'node:child_process';

export interface CommandCheck {
  name: string;
  minVersion?: number;
  command: string;
}

export interface PrerequisiteResult {
  name: string;
  ok: boolean;
  version?: string;
  message: string;
}

function extractVersion(output: string): string | undefined {
  const match = output.match(/(\d+)\.\d+(?:\.\d+)?/);
  return match?.[0];
}

function checkCommand(name: string, command: string, minVersion?: number): PrerequisiteResult {
  try {
    const output = execSync(command, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const version = extractVersion(output);
    const major = version ? parseInt(version.split('.')[0], 10) : undefined;

    if (minVersion !== undefined && major !== undefined && major < minVersion) {
      return {
        name,
        ok: false,
        version,
        message: `${name} version ${version} is too old. Need >= ${minVersion}.`
      };
    }

    return {
      name,
      ok: true,
      version,
      message: `${name} ${version || 'found'} ✓`
    };
  } catch (err) {
    return {
      name,
      ok: false,
      message: `${name} not found or failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export function checkNodeVersion(): PrerequisiteResult {
  return checkCommand('Node.js', 'node --version', 18);
}

export function checkNpm(): PrerequisiteResult {
  return checkCommand('npm', 'npm --version');
}

export function checkGit(): PrerequisiteResult {
  return checkCommand('git', 'git --version');
}

export function checkWrangler(): PrerequisiteResult {
  return checkCommand('wrangler', 'npx wrangler --version');
}

export function installWrangler(): void {
  console.log('Installing wrangler...');
  execSync('npm install -g wrangler', { stdio: 'inherit' });
}

export function checkPrerequisites(): PrerequisiteResult[] {
  const results = [checkNodeVersion(), checkNpm(), checkGit(), checkWrangler()];
  return results;
}

export function ensurePrerequisites(): void {
  const results = checkPrerequisites();
  let failed = false;
  for (const result of results) {
    console.log(result.message);
    if (!result.ok) {
      failed = true;
      if (result.name === 'wrangler') {
        installWrangler();
      }
    }
  }

  if (failed) {
    const stillFailing = checkPrerequisites().filter((r) => !r.ok);
    if (stillFailing.length > 0) {
      const names = stillFailing.map((r) => r.name).join(', ');
      throw new Error(`Missing prerequisites after install attempt: ${names}`);
    }
  }
}
