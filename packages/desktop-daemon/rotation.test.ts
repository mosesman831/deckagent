/**
 * Focused rotation coverage for daemon and audit logs.
 * Run via: npm test --workspace=packages/desktop-daemon
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditLog, getAuditLogPath } from "./src/audit-log.js";
import { Logger } from "./src/logger.js";

function testAuditRotationRetainsFive(): void {
  const dir = mkdtempSync(join(tmpdir(), "deckagent-audit-rotation-"));
  try {
    const auditPath = getAuditLogPath(dir);
    for (let i = 1; i <= 8; i++) {
      writeFileSync(join(dir, `audit.jsonl.${i}`), `old-${i}`);
    }
    writeFileSync(auditPath, "x".repeat(1000));

    appendAuditLog(
      {
        ts: new Date().toISOString(),
        id: "rotation-test",
        tool: "get_environment",
        args_summary: {},
        outcome: "ok",
        duration_ms: 1,
        source: "tunnel",
      },
      { logDir: dir, maxBytes: 500 },
    );

    const rotated = readdirSync(dir).filter((name) =>
      /^audit\.jsonl\.\d+$/.test(name),
    );
    assert.ok(rotated.length <= 5, `expected <=5 audit rotations, found ${rotated.length}`);
    assert.equal(existsSync(join(dir, "audit.jsonl.6")), false);
    assert.equal(existsSync(join(dir, "audit.jsonl.7")), false);
    assert.equal(existsSync(join(dir, "audit.jsonl.8")), false);
    assert.equal(existsSync(auditPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testDaemonLoggerRotationRetainsFive(): void {
  const dir = mkdtempSync(join(tmpdir(), "deckagent-logger-rotation-"));
  try {
    for (let i = 1; i <= 8; i++) {
      const file = join(dir, `deckagent-2000-01-01.log.${i}`);
      writeFileSync(file, `old-${i}`);
      const time = new Date(1_000 + i * 1_000);
      utimesSync(file, time, time);
    }
    writeFileSync(join(dir, "deckagent-2000-01-01.log"), "active");

    const logger = new Logger("error", false, { logDir: dir, keepFiles: 5 });
    logger.rotate();
    logger.shutdown();

    const rotated = readdirSync(dir).filter((name) =>
      /^deckagent-\d{4}-\d{2}-\d{2}\.log\.\d+$/.test(name),
    );
    assert.ok(rotated.length <= 5, `expected <=5 daemon log rotations, found ${rotated.length}`);
    assert.equal(existsSync(join(dir, "deckagent-2000-01-01.log")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

testAuditRotationRetainsFive();
testDaemonLoggerRotationRetainsFive();
console.log("rotation tests passed");
