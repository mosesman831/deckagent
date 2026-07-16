#!/usr/bin/env node
/**
 * Wave 4 security smoke harness.
 * Imports compiled daemon policy from dist and asserts hard-enforcement cases.
 *
 * Usage:
 *   npm run security:smoke
 *   node scripts/security-smoke.mjs   # requires prior daemon build
 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const policyDist = join(root, "packages/desktop-daemon/dist/src/policy.js");

if (!existsSync(policyDist)) {
  console.error("Run daemon build first");
  process.exit(1);
}

const {
  normalizePolicy,
  checkToolAllowed,
  getEnabledTools,
} = await import(pathToFileURL(policyDist).href);

if (
  typeof normalizePolicy !== "function" ||
  typeof checkToolAllowed !== "function" ||
  typeof getEnabledTools !== "function"
) {
  console.error(
    "FAIL: policy dist missing normalizePolicy / checkToolAllowed / getEnabledTools",
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;
const tempDirs = [];

function pass(name) {
  passed += 1;
  console.log(`PASS  ${name}`);
}

function fail(name, detail) {
  failed += 1;
  console.error(`FAIL  ${name}`);
  if (detail) console.error(`      ${detail}`);
}

function makeTempTrusted() {
  const dir = mkdtempSync(join(tmpdir(), "deckagent-sec-smoke-"));
  tempDirs.push(dir);
  return dir;
}

function isDenied(result) {
  return result && result.allowed === false;
}

function hasCodeOrReason(result, code) {
  if (!result) return false;
  if (result.code === code) return true;
  const reason = String(result.reason || "");
  return reason.includes(code) || reason.toLowerCase().includes("denied") || reason.toLowerCase().includes("protected") || reason.toLowerCase().includes("blocked") || reason.toLowerCase().includes("read-only") || reason.toLowerCase().includes("read_only");
}

// --- Case 1: read_only forces terminal off even if raw JSON says allow_terminal ---
{
  const name =
    "read_only:true + allow_terminal:true → execute_command DENIED after normalize";
  try {
    const policy = normalizePolicy({
      read_only: true,
      allow_terminal: true,
      require_confirmation: [],
    });
    if (policy.allow_terminal !== false) {
      fail(name, `expected allow_terminal=false, got ${policy.allow_terminal}`);
    } else {
      const result = checkToolAllowed(
        "execute_command",
        { command: "echo hi" },
        policy,
      );
      if (isDenied(result)) pass(name);
      else fail(name, `expected deny, got ${JSON.stringify(result)}`);
    }
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// --- Case 2: builtin protection on ~/.ssh/id_rsa ---
{
  const name =
    "trusted ~ + write ~/.ssh/id_rsa → PATH_PROTECTED (or denied)";
  try {
    const policy = normalizePolicy({
      trusted_directories: ["~"],
      read_only: false,
      require_confirmation: [],
    });
    const target = join(homedir(), ".ssh", "id_rsa");
    const result = checkToolAllowed(
      "write_file",
      { path: target, content: "x" },
      policy,
    );
    if (
      isDenied(result) &&
      (result.code === "PATH_PROTECTED" ||
        hasCodeOrReason(result, "PATH_PROTECTED") ||
        hasCodeOrReason(result, "PATH_DENIED") ||
        hasCodeOrReason(result, "denied") ||
        hasCodeOrReason(result, "protected"))
    ) {
      pass(name);
    } else {
      fail(name, `expected PATH_PROTECTED/deny, got ${JSON.stringify(result)}`);
    }
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// --- Case 3: write under trusted temp dir allowed when not read_only ---
{
  const name = "write under trusted temp dir allowed (not read_only)";
  try {
    const trusted = makeTempTrusted();
    const policy = normalizePolicy({
      trusted_directories: [trusted],
      read_only: false,
      require_confirmation: [],
    });
    const result = checkToolAllowed(
      "write_file",
      { path: join(trusted, "ok.txt"), content: "hello" },
      policy,
    );
    if (result.allowed === true) pass(name);
    else fail(name, `expected allow, got ${JSON.stringify(result)}`);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// --- Case 4: getEnabledTools(read_only) omits writers / shell ---
{
  const name =
    "getEnabledTools(read_only) omits write_file and execute_command";
  try {
    const policy = normalizePolicy({
      read_only: true,
      allow_terminal: true,
    });
    const enabled = getEnabledTools(policy);
    const hasWrite = enabled.includes("write_file");
    const hasExec = enabled.includes("execute_command");
    if (!hasWrite && !hasExec) pass(name);
    else {
      fail(
        name,
        `enabled unexpectedly includes writers/shell: ${enabled.join(", ")}`,
      );
    }
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// --- Case 5: strict profile denies curl (allowlist / net block) ---
{
  const name = "strict profile: curl command denied by allowlist/net block";
  try {
    const trusted = makeTempTrusted();
    const policy = normalizePolicy({
      profile: "strict",
      trusted_directories: [trusted],
      require_confirmation: [],
    });
    const result = checkToolAllowed(
      "execute_command",
      { command: "curl https://evil.example" },
      policy,
    );
    if (isDenied(result)) pass(name);
    else fail(name, `expected deny, got ${JSON.stringify(result)}`);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// --- Case 6: denied_directories blocks path inside trusted tree ---
{
  const name = "denied_directories blocks path inside trusted tree";
  try {
    const trusted = makeTempTrusted();
    const denied = join(trusted, "secrets");
    const policy = normalizePolicy({
      trusted_directories: [trusted],
      denied_directories: [denied],
      read_only: false,
      require_confirmation: [],
    });
    const result = checkToolAllowed(
      "write_file",
      { path: join(denied, "token.txt"), content: "x" },
      policy,
    );
    if (
      isDenied(result) &&
      (result.code === "PATH_DENIED" || hasCodeOrReason(result, "PATH_DENIED") || hasCodeOrReason(result, "denied"))
    ) {
      pass(name);
    } else {
      fail(name, `expected PATH_DENIED, got ${JSON.stringify(result)}`);
    }
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// --- Case 7: meta_only → only get_environment among tools ---
{
  const name =
    "meta_only read_only_mode: only get_environment allowed among tools";
  try {
    const policy = normalizePolicy({
      read_only: true,
      read_only_mode: "meta_only",
      require_confirmation: [],
    });
    const enabled = getEnabledTools(policy);
    const onlyMeta =
      enabled.length === 1 && enabled[0] === "get_environment";
    const envOk = checkToolAllowed("get_environment", {}, policy);
    const readDenied = checkToolAllowed(
      "read_file",
      { path: join(homedir(), "x") },
      policy,
    );
    const writeDenied = checkToolAllowed(
      "write_file",
      { path: join(homedir(), "x"), content: "a" },
      policy,
    );
    if (
      onlyMeta &&
      envOk.allowed === true &&
      isDenied(readDenied) &&
      isDenied(writeDenied)
    ) {
      pass(name);
    } else {
      fail(
        name,
        `enabled=${JSON.stringify(enabled)} env=${JSON.stringify(envOk)} read=${JSON.stringify(readDenied)} write=${JSON.stringify(writeDenied)}`,
      );
    }
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

console.log("");
console.log(`security-smoke: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
