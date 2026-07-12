import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgram } from "../src/index.js";
import { getConfigPath, loadConfig, saveConfig } from "../src/config.js";
import { generateDeviceId, generateToken } from "../src/device.js";

test("commander parses the version flag", async () => {
  const program = createProgram();
  assert.equal(program.name(), "deckagent");
  assert.equal(program.version(), "1.0.0");
  program.exitOverride();
  await assert.rejects(() => program.parseAsync(["node", "deckagent", "--version"]), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "commander.version";
  });
});

test("config helpers use a supplied home directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "deckagent-cli-"));
  try {
    const path = getConfigPath(home);
    assert.equal(path, join(home, ".deckagent", "config.json"));
    assert.equal(await loadConfig(path), null);
    await saveConfig({ device_id: generateDeviceId(), token: generateToken(), worker_url: "https://example.workers.dev", device_name: "test", heartbeat_interval: 15, tool_timeout: 60, auto_connect: true, log_level: "info" }, path);
    assert.equal((await loadConfig(path))?.device_name, "test");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("token and device ID generators produce valid values", () => {
  assert.match(generateToken(), /^[a-f0-9]{64}$/);
  assert.match(generateDeviceId(), /^[0-9a-f-]{36}$/);
});
