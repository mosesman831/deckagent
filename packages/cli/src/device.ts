import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, saveConfig, type DeckAgentConfig } from "./config.js";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateDeviceId(): string {
  return randomUUID();
}

export async function registerDevice(options: { deploySecret?: string; deviceName?: string } = {}): Promise<DeckAgentConfig> {
  const existing = await loadConfig();
  if (!existing) throw new Error("Run deckagent setup first, or create ~/.deckagent/config.json");
  const deploySecret = options.deploySecret ?? await prompt("Deployment secret: ");
  if (!deploySecret) throw new Error("A deployment secret is required to register a device");
  const config: DeckAgentConfig = {
    ...existing,
    device_id: existing.device_id || generateDeviceId(),
    token: existing.token || generateToken(),
    device_name: options.deviceName ?? existing.device_name
  };
  const response = await fetch(`${config.worker_url.replace(/\/$/, "")}/api/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deploySecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      device_id: config.device_id,
      name: config.device_name,
      token: config.token,
      capabilities: ["filesystem", "terminal", "browser"]
    })
  });
  if (!response.ok) throw new Error(`Device registration failed: ${response.status} ${await response.text()}`);
  await saveConfig(config);
  console.log(`Registered device ${config.device_id}`);
  return config;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
