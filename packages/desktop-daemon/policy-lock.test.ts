/**
 * Smoke tests for policy-lock unlock token helpers (S8).
 * Run via: npm test (policy-lock.test.js)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNLOCK_HEADER,
  UNLOCK_TTL_MS,
  createUnlockToken,
  clearUnlockToken,
  isValidUnlockToken,
  validateAndConsumeUnlockToken,
  isUnlockTokenExpired,
  extractUnlockToken,
  getUnlockTokenPath,
} from "./src/policy-lock.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(
    actual === expected,
    `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

function main(): void {
  console.log("policy-lock smoke tests");

  assertEqual(UNLOCK_HEADER, "x-deckagent-unlock", "UNLOCK_HEADER");
  assert(UNLOCK_TTL_MS === 5 * 60 * 1000, "UNLOCK_TTL_MS is 5 minutes");

  const dir = mkdtempSync(join(tmpdir(), "deckagent-unlock-"));
  try {
    const record = createUnlockToken(dir);
    assert(typeof record.token === "string" && record.token.length >= 32, "token created");
    assert(!!record.expires_at, "expires_at set");

    assert(
      isValidUnlockToken(record.token, dir),
      "valid token accepted",
    );
    assert(
      !isValidUnlockToken("wrong-token", dir),
      "wrong token rejected",
    );

    assert(
      !isUnlockTokenExpired(record, Date.now()),
      "fresh token not expired",
    );
    assert(
      isUnlockTokenExpired(record, Date.parse(record.expires_at) + 1),
      "token expired after TTL",
    );

    const consumed = validateAndConsumeUnlockToken(record.token, dir);
    assert(consumed, "validateAndConsume succeeds once");
    assert(
      !isValidUnlockToken(record.token, dir),
      "token consumed (file cleared)",
    );

    clearUnlockToken(dir);
    assert(!getUnlockTokenPath(dir).endsWith("nope"), "unlock path helper works");

    assertEqual(
      extractUnlockToken({ headerValue: " abc ", body: { token: "body" } }),
      "abc",
      "header wins over body",
    );
    assertEqual(
      extractUnlockToken({ body: { token: " from-body " } }),
      "from-body",
      "body token used when no header",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
