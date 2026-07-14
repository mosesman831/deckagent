import {
  DeepSeekAdapter,
  extractToolCalls,
  appendToolResult,
} from "../src/adapters/deepseek.js";
import type { InterceptedRequest, InterceptedResponse } from "../src/adapters/types.js";

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

function makeReq(body: string): InterceptedRequest {
  return {
    id: "r1",
    url: "https://chat.deepseek.com/api/chat",
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timestamp: Date.now(),
    adapterType: "deepseek",
  };
}

function makeRes(body: string): InterceptedResponse {
  return {
    id: "s1",
    requestId: "r1",
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body,
    timestamp: Date.now(),
  };
}

console.log("DeepSeek adapter tests");

test("matches DeepSeek chat URL", () => {
  assertTrue(DeepSeekAdapter.match("https://chat.deepseek.com/api/chat"));
});

test("matches DeepSeek base URL", () => {
  assertTrue(DeepSeekAdapter.match("https://deepseek.com/api/chat"));
});

test("rejects unrelated hosts", () => {
  assertTrue(!DeepSeekAdapter.match("https://api.openai.com/v1/chat"));
  assertTrue(!DeepSeekAdapter.match("https://example.com/deepseek"));
});

test("injects system prompt into request body", () => {
  const req = makeReq(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
  const transformed = DeepSeekAdapter.transformRequest!(req);
  const body = JSON.parse(transformed.body);
  assertEqual(body.messages[0].role, "system");
  assertTrue(body.messages[0].content.includes("DeckAgent"));
  assertEqual(body.messages[1], { role: "user", content: "hi" });
});

test("prepends system prompt before existing system message without DeckAgent", () => {
  const req = makeReq(JSON.stringify({ messages: [{ role: "system", content: "existing" }] }));
  const transformed = DeepSeekAdapter.transformRequest!(req);
  const body = JSON.parse(transformed.body);
  assertEqual(body.messages.length, 1);
  assertTrue(body.messages[0].content.startsWith("You have access to a local machine"));
  assertTrue(body.messages[0].content.includes("existing"));
});

test("does not duplicate system prompt when DeckAgent present", () => {
  const first = DeepSeekAdapter.transformRequest!(makeReq(JSON.stringify({ messages: [{ role: "user", content: "hi" }] })));
  const second = DeepSeekAdapter.transformRequest!(first);
  const body = JSON.parse(second.body);
  const matches = (body.messages[0].content.match(/DeckAgent/g) ?? []).length;
  assertEqual(matches, 1);
});

test("handles array request body format", () => {
  const req = makeReq(JSON.stringify([{ role: "user", content: "hi" }]));
  const transformed = DeepSeekAdapter.transformRequest!(req);
  assertEqual(transformed.body, req.body, "array body should be passed through unchanged");
});

test("handles empty request body", () => {
  const req = makeReq("");
  const transformed = DeepSeekAdapter.transformRequest!(req);
  assertEqual(transformed.body, "");
});

test("handles malformed JSON request body", () => {
  const req = makeReq("not json");
  const transformed = DeepSeekAdapter.transformRequest!(req);
  assertEqual(transformed.body, "not json");
});

test("extracts tool calls from non-streaming response", () => {
  const content = `Hello <<<TOOL>>>{"name":"read_file","args":{"path":"/foo"}}<<<END>>>`;
  const res = makeRes(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  const out = DeepSeekAdapter.transformResponse!(makeReq("{}"), res);
  const calls = extractToolCalls(out.body);
  assertEqual(calls, [{ name: "read_file", args: { path: "/foo" } }]);
});

test("extracts multiple tool calls from non-streaming response", () => {
  const content = `x <<<TOOL>>>{"name":"a","args":{"x":1}}<<<END>>> y <<<TOOL>>>{"name":"b","args":{"y":2}}<<<END>>>`;
  const res = makeRes(JSON.stringify({ choices: [{ message: { content } }] }));
  const calls = extractToolCalls(res.body);
  assertEqual(calls, [
    { name: "a", args: { x: 1 } },
    { name: "b", args: { y: 2 } },
  ]);
});

test("extracts tool calls from SSE streaming response", () => {
  const chunks = [
    { choices: [{ delta: { content: "Sure" } }] },
    { choices: [{ delta: { content: ", tool: <<<TOOL>>>" } }] },
    { choices: [{ delta: { content: '{"name":"execute_command","args":{"command":"ls"}}<<<END>>> done' } }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\ndata: [DONE]\n";
  const calls = extractToolCalls(body);
  assertEqual(calls, [{ name: "execute_command", args: { command: "ls" } }]);
});

test("extracts tool calls split across multiple SSE chunks", () => {
  const chunks = [
    { choices: [{ delta: { content: '<<<TOOL>>>{"name":"' } }] },
    { choices: [{ delta: { content: 'read_file","args":{"path":"/foo"}}<<<END>>>' } }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\n";
  const calls = extractToolCalls(body);
  assertEqual(calls, [{ name: "read_file", args: { path: "/foo" } }]);
});

test("returns null when no tool pattern present in non-streaming response", () => {
  const res = makeRes(JSON.stringify({ choices: [{ message: { content: "just text" } }] }));
  const calls = extractToolCalls(res.body);
  assertEqual(calls, null);
});

test("returns null for malformed tool JSON inside pattern", () => {
  const res = makeRes(JSON.stringify({ choices: [{ message: { content: "<<<TOOL>>>not valid json<<<END>>>" } }] }));
  const calls = extractToolCalls(res.body);
  assertEqual(calls, null);
});

test("extracts from plain text response", () => {
  const body = `some text <<<TOOL>>>{"name":"list_directory","args":{"path":"/"}}<<<END>>> more`;
  const calls = extractToolCalls(body);
  assertEqual(calls, [{ name: "list_directory", args: { path: "/" } }]);
});

test("handles empty response body", () => {
  const calls = extractToolCalls("");
  assertEqual(calls, null);
});

test("handles malformed JSON response body", () => {
  const calls = extractToolCalls("not valid json");
  assertEqual(calls, null);
});

test("handles SSE chunks with missing content delta", () => {
  const body = [
    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}",
    "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}",
  ].join("\n");
  const calls = extractToolCalls(body);
  assertEqual(calls, null);
});

test("appendToolResult adds assistant tool result message", () => {
  const body = appendToolResult(
    JSON.stringify({ messages: [{ role: "user", content: "run" }] }),
    'read_file result: "hello"'
  );
  const parsed = JSON.parse(body);
  assertEqual(parsed.messages.length, 2);
  assertEqual(parsed.messages[1].role, "assistant");
  assertTrue(parsed.messages[1].content.includes("TOOL_RESULT"));
});

test("appendToolResult returns body unchanged for array body", () => {
  const body = JSON.stringify([{ role: "user", content: "hi" }]);
  assertEqual(appendToolResult(body, "result"), body);
});

test("appendToolResult returns body unchanged for invalid JSON", () => {
  assertEqual(appendToolResult("not json", "result"), "not json");
});

test("appendToolResult returns body unchanged for empty body", () => {
  assertEqual(appendToolResult("", "result"), "");
});

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
