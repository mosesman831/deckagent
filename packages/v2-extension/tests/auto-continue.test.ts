import {
  MAX_AUTO_CONTINUES,
  appendResultsToBody,
  anyToolError,
  canAutoContinue,
  createAutoContinueState,
  decideAutoContinue,
  formatResultContents,
  hasMessagesArray,
  recordAutoContinue,
  remainingAutoContinues,
  resetAutoContinue
} from "../src/lib/auto-continue.js";
import { appendToolResultFor } from "../src/adapters/tools.js";

let total = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  total++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ? msg + "\n" : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertTrue(value: boolean, msg?: string) {
  if (!value) throw new Error(msg || "assertion failed");
}

console.log("Auto-continue unit tests");

test("MAX_AUTO_CONTINUES is 3", () => {
  assertEqual(MAX_AUTO_CONTINUES, 3);
});

test("createAutoContinueState starts at zero", () => {
  const state = createAutoContinueState();
  assertEqual(state.count, 0);
  assertEqual(state.lastAt, 0);
  assertTrue(canAutoContinue(state));
  assertEqual(remainingAutoContinues(state), 3);
});

test("recordAutoContinue increments until cap", () => {
  const state = createAutoContinueState();
  recordAutoContinue(state, 1000);
  assertEqual(state.count, 1);
  assertEqual(state.lastAt, 1000);
  assertTrue(canAutoContinue(state));

  recordAutoContinue(state, 2000);
  recordAutoContinue(state, 3000);
  assertEqual(state.count, 3);
  assertTrue(!canAutoContinue(state), "should be capped after 3");
  assertEqual(remainingAutoContinues(state), 0);
});

test("resetAutoContinue clears the turn counter", () => {
  const state = createAutoContinueState();
  recordAutoContinue(state, 1000);
  recordAutoContinue(state, 2000);
  resetAutoContinue(state);
  assertEqual(state.count, 0);
  assertEqual(state.lastAt, 0);
  assertTrue(canAutoContinue(state));
});

test("hasMessagesArray detects messages field", () => {
  assertTrue(hasMessagesArray(JSON.stringify({ messages: [] })));
  assertTrue(hasMessagesArray(JSON.stringify({ messages: [{ role: "user", content: "hi" }] })));
  assertTrue(!hasMessagesArray(JSON.stringify({ prompt: "hi" })));
  assertTrue(!hasMessagesArray("not json"));
  assertTrue(!hasMessagesArray(""));
});

test("anyToolError detects failures", () => {
  assertTrue(!anyToolError([{ name: "a", ok: true, content: "x" }]));
  assertTrue(anyToolError([{ name: "a", ok: true }, { name: "b", ok: false, error: "nope" }]));
});

test("formatResultContents formats ok and error items", () => {
  assertEqual(formatResultContents([{ name: "read_file", ok: true, content: "hello" }]), [
    "read_file: hello"
  ]);
  assertEqual(formatResultContents([{ name: "x", ok: false, error: "boom" }]), [
    "x: Error executing x: boom"
  ]);
});

test("appendResultsToBody appends via adapter helper", () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const next = appendResultsToBody("deepseek", body, ["read_file: data"]);
  assertTrue(next !== null, "should return augmented body");
  const parsed = JSON.parse(next!) as { messages: Array<{ role: string; content: string }> };
  assertEqual(parsed.messages.length, 2);
  assertTrue(parsed.messages[1].content.includes("TOOL_RESULT"));
  assertTrue(parsed.messages[1].content.includes("read_file: data"));
});

test("appendResultsToBody returns null without messages array", () => {
  assertEqual(appendResultsToBody("deepseek", JSON.stringify({ foo: 1 }), ["x"]), null);
  assertEqual(appendResultsToBody("deepseek", "not json", ["x"]), null);
  assertEqual(appendResultsToBody("deepseek", bodyWithMessages(), []), null);
});

function bodyWithMessages(): string {
  return JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
}

test("appendToolResultFor matches adapter append", () => {
  const body = bodyWithMessages();
  const a = appendToolResultFor("deepseek", body, "result-a");
  const b = appendResultsToBody("deepseek", body, ["result-a"]);
  assertEqual(a, b);
});

test("decideAutoContinue resubmits when under cap with valid body", () => {
  const state = createAutoContinueState();
  const decision = decideAutoContinue({
    state,
    results: [{ name: "read_file", ok: true, content: "abc" }],
    adapterType: "deepseek",
    requestBody: bodyWithMessages()
  });
  assertEqual(decision.action, "resubmit");
  if (decision.action === "resubmit") {
    assertTrue(decision.body.includes("TOOL_RESULT"));
    assertEqual(decision.contents, ["read_file: abc"]);
  }
});

test("decideAutoContinue stops on tool error", () => {
  const state = createAutoContinueState();
  const decision = decideAutoContinue({
    state,
    results: [{ name: "read_file", ok: false, error: "denied" }],
    adapterType: "deepseek",
    requestBody: bodyWithMessages()
  });
  assertEqual(decision.action, "stop");
  if (decision.action === "stop") {
    assertTrue(decision.reason.includes("failed") || decision.reason.includes("Tool"));
  }
});

test("decideAutoContinue queues after max continues", () => {
  const state = createAutoContinueState();
  recordAutoContinue(state, 1);
  recordAutoContinue(state, 2);
  recordAutoContinue(state, 3);
  const decision = decideAutoContinue({
    state,
    results: [{ name: "read_file", ok: true, content: "abc" }],
    adapterType: "deepseek",
    requestBody: bodyWithMessages()
  });
  assertEqual(decision.action, "queue");
  if (decision.action === "queue") {
    assertTrue(decision.reason.includes("limit") || decision.reason.includes("3"));
  }
});

test("decideAutoContinue queues when no messages array", () => {
  const state = createAutoContinueState();
  const decision = decideAutoContinue({
    state,
    results: [{ name: "read_file", ok: true, content: "abc" }],
    adapterType: "deepseek",
    requestBody: JSON.stringify({ prompt: "hi" })
  });
  assertEqual(decision.action, "queue");
});

test("decideAutoContinue queues when request body missing", () => {
  const state = createAutoContinueState();
  const decision = decideAutoContinue({
    state,
    results: [{ name: "read_file", ok: true, content: "abc" }],
    adapterType: "deepseek",
    requestBody: null
  });
  assertEqual(decision.action, "queue");
});

test("decideAutoContinue allows exactly 3 sequential continues", () => {
  const state = createAutoContinueState();
  const body = bodyWithMessages();

  for (let i = 0; i < MAX_AUTO_CONTINUES; i++) {
    const decision = decideAutoContinue({
      state,
      results: [{ name: "t", ok: true, content: `r${i}` }],
      adapterType: "deepseek",
      requestBody: body
    });
    assertEqual(decision.action, "resubmit", `continue #${i + 1} should resubmit`);
    recordAutoContinue(state, i + 1);
  }

  const blocked = decideAutoContinue({
    state,
    results: [{ name: "t", ok: true, content: "r3" }],
    adapterType: "deepseek",
    requestBody: body
  });
  assertEqual(blocked.action, "queue", "4th continue must queue");
});

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
