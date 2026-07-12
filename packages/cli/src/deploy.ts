import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { loadConfig, saveConfig, type DeckAgentConfig } from "./config.js";

export async function deployWorker(workerDir = "packages/cloudflare-worker"): Promise<string> {
  try {
    await access(`${workerDir}/wrangler.jsonc`);
  } catch {
    throw new Error(`Cloudflare Worker config not found: ${workerDir}/wrangler.jsonc`);
  }
  const output = await runCommand("npx", ["wrangler", "deploy"], workerDir);
  const workerUrl = output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev[^\s]*/i)?.[0]?.replace(/[.)]+$/, "");
  if (!workerUrl) throw new Error("Worker deployed, but Wrangler did not report a workers.dev URL");
  return workerUrl;
}

export async function deployCommand(): Promise<void> {
  const workerUrl = await deployWorker();
  const config = await loadConfig();
  if (config) await saveConfig({ ...config, worker_url: workerUrl });
  console.log(`Worker URL: ${workerUrl}`);
}

export async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); process.stderr.write(chunk); });
    child.on("error", () => reject(new Error(`Unable to run ${command}. Is it installed?`)));
    child.on("close", (code) => code === 0 ? resolve(`${stdout}\n${stderr}`) : reject(new Error(`${command} failed with exit code ${code ?? "unknown"}`)));
  });
}

export async function readWorkerConfig(path = "packages/cloudflare-worker/wrangler.jsonc"): Promise<string> {
  return readFile(path, "utf8");
}
