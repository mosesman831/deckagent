import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { buildProgram } from "../src/index.js";
import {
  type Config,
  ConfigSchema,
  configExists,
  defaultPolicy,
  generateDeploySecret,
  generateDeviceId,
  generateToken,
  getConfigPath,
  getPolicyPath,
  loadConfig,
  loadPolicy,
  saveConfig,
  savePolicy,
} from "../src/config.js";
import { parseWorkerUrl } from "../src/deploy.js";
import { parseKvId } from "../src/setup.js";

describe("commander CLI", () => {
  test("exposes name and version", () => {
    const program = buildProgram();
    assert.equal(program.name(), "deckagent");
    assert.equal(program.version(), "1.0.0");
  });

  test("--version does not throw with exitOverride", () => {
    const program = buildProgram();
    program.exitOverride();
    let output = "";
    program.configureOutput({
      writeOut: (s) => {
        output += s;
      },
    });
    assert.throws(
      () => program.parse(["node", "deckagent", "--version"]),
      /1\.0\.0|commander/,
    );
    assert.match(output, /1\.0\.0/);
  });

  test("registers all top-level commands", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).sort();
    assert.deepEqual(names, [
      "daemon",
      "deploy",
      "install",
      "logs",
      "register",
      "setup",
      "uninstall",
    ]);
  });
});

describe("identity generation", () => {
  test("generateToken is 64 lowercase hex chars", () => {
    const token = generateToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(generateToken(), token);
  });

  test("generateDeploySecret is 64 hex chars", () => {
    assert.match(generateDeploySecret(), /^[0-9a-f]{64}$/);
  });

  test("generateDeviceId is a UUID v4", () => {
    assert.match(
      generateDeviceId(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("config + policy IO", () => {
  let home: string;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "deckagent-test-"));
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("getConfigPath / getPolicyPath resolve under ~/.deckagent", () => {
    assert.ok(getConfigPath(home).endsWith(join(".deckagent", "config.json")));
    assert.ok(getPolicyPath(home).endsWith(join(".deckagent", "policy.json")));
  });

  test("loadConfig returns null when missing", () => {
    assert.equal(configExists(home), false);
    assert.equal(loadConfig(home), null);
  });

  test("saveConfig then loadConfig round-trips", () => {
    const config: Config = ConfigSchema.parse({
      device_id: generateDeviceId(),
      token: generateToken(),
      worker_url: "https://deckagent.example.workers.dev",
      device_name: "test-device",
    });
    saveConfig(config, home);
    assert.equal(configExists(home), true);
    const loaded = loadConfig(home);
    assert.ok(loaded);
    assert.equal(loaded?.device_id, config.device_id);
    assert.equal(loaded?.worker_url, config.worker_url);
    assert.equal(loaded?.heartbeat_interval, 15);
    assert.equal(loaded?.log_level, "info");
  });

  test("invalid config throws a human-readable error", () => {
    const badHome = mkdtempSync(join(tmpdir(), "deckagent-bad-"));
    try {
      const path = getConfigPath(badHome);
      mkdirSync(dirname(path), { recursive: true });
      // Missing required fields + bad url.
      writeFileSync(path, JSON.stringify({ worker_url: "not-a-url" }), "utf8");
      assert.throws(() => loadConfig(badHome), /Invalid config/);
    } finally {
      rmSync(badHome, { recursive: true, force: true });
    }
  });

  test("policy round-trips with defaults", () => {
    savePolicy(defaultPolicy(home), home);
    const loaded = loadPolicy(home);
    assert.ok(loaded);
    assert.equal(loaded?.version, 1);
    assert.equal(loaded?.read_only, false);
    assert.ok(loaded?.blocked_commands.includes("rm -rf"));
    assert.ok(loaded?.allowed_directories.includes(home));
  });
});

describe("wrangler output parsing", () => {
  test("parseWorkerUrl finds the workers.dev url", () => {
    const out = "Published deckagent\n  https://deckagent.jane.workers.dev\n";
    assert.equal(parseWorkerUrl(out), "https://deckagent.jane.workers.dev");
  });

  test("parseWorkerUrl returns null when absent", () => {
    assert.equal(parseWorkerUrl("no url here"), null);
  });

  test("parseKvId parses toml, jsonc, and plain forms", () => {
    const id = "0123456789abcdef0123456789abcdef";
    assert.equal(parseKvId(`id = "${id}"`), id);
    assert.equal(parseKvId(`"id": "${id}"`), id);
    assert.equal(parseKvId(`id: ${id}`), id);
    assert.equal(parseKvId("nothing"), null);
  });
});
