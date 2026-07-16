import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Root of the `@deckagent/cli` package (contains package.json, assets/, dist/).
 * Works when this module is loaded from `src/` (tsx) or `dist/` (built).
 */
export function getCliPackageRoot(): string {
  // dist/paths.js → .. ; src/paths.ts → ..
  return path.resolve(__dirname, '..');
}

/**
 * Candidate directories for the Cloudflare Worker package, in preference order:
 * 1. Monorepo sibling packages/cloudflare-worker
 * 2. Bundled assets under packages/cli/assets/worker (npx / published install)
 */
export function getWorkerPackageCandidates(cliPackageRoot: string = getCliPackageRoot()): string[] {
  return [
    path.resolve(cliPackageRoot, '..', 'cloudflare-worker'),
    path.join(cliPackageRoot, 'assets', 'worker')
  ];
}

/**
 * Candidate directories for the desktop-daemon package (filesystem only).
 * npm dependency resolution is handled separately in resolveDaemonPaths.
 */
export function getDaemonPackageCandidates(cliPackageRoot: string = getCliPackageRoot()): string[] {
  return [path.resolve(cliPackageRoot, '..', 'desktop-daemon')];
}
