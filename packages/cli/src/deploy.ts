import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  configExists,
  getWorkerDir,
  getWranglerConfigPath,
  loadConfig,
  saveConfig,
} from "./config.js";
import { run, runCapture, type RunResult } from "./daemon.js";

/** Run wrangler via npx (streaming output). */
export function wrangler(args: string[], cwd?: string): void {
  run("npx", ["--yes", "wrangler", ...args], { cwd });
}

/** Run wrangler via npx and capture output. */
export function wranglerCapture(args: string[], cwd?: string): RunResult {
  return runCapture("npx", ["--yes", "wrangler", ...args], { cwd });
}

/**
 * Extract the deployed workers.dev URL from wrangler deploy output.
 * Lines look like: `  https://deckagent.subdomain.workers.dev`
 */
export function parseWorkerUrl(output: string): string | null {
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/);
  return match ? match[0].replace(/\/$/, "") : null;
}

export interface DeployOptions {
  /** Skip writing the discovered URL back into config.json. */
  skipConfigUpdate?: boolean;
}

/**
 * Deploy the Cloudflare Worker with wrangler and, when possible, record the
 * deployed URL in ~/.deckagent/config.json.
 * Returns the deployed worker URL (or null if it could not be parsed).
 */
export function runDeploy(
  options: DeployOptions = {},
  home: string = homedir(),
): string | null {
  const workerDir = getWorkerDir();
  const wranglerConfig = getWranglerConfigPath();
  if (!existsSync(wranglerConfig)) {
    throw new Error(
      `Missing ${wranglerConfig}. Run \`deckagent setup\` to generate it before deploying.`,
    );
  }

  console.log("Deploying Cloudflare Worker with wrangler...");
  const result = wranglerCapture(["deploy"], workerDir);
  // Surface wrangler output to the user regardless of success.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) {
    throw new Error(`wrangler deploy failed (exit ${result.code}).`);
  }

  const url = parseWorkerUrl(`${result.stdout}\n${result.stderr}`);
  if (url) {
    console.log(`Worker deployed at ${url}`);
    if (!options.skipConfigUpdate && configExists(home)) {
      const config = loadConfig(home);
      if (config && config.worker_url !== url) {
        saveConfig({ ...config, worker_url: url }, home);
        console.log("Updated worker_url in config.json");
      }
    }
  } else {
    console.log("Deployed, but could not parse the worker URL from output.");
  }
  return url;
}
