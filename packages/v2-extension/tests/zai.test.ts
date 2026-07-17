import type { InterceptedRequest, InterceptedResponse, ToolCall } from "../src/adapters/types.js";
import { zaiAdapter, extractToolCalls, appendToolResult } from "../src/adapters/zai.js";

let failures = 0;
let total = 0;

function test(label: string, fn: () => void): void {
  total++;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${label}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label?: string): void {
  if (actual !== expected) {
    throw new Error(`${label ? `${label}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, label?: string): void {
  if (!condition) throw new Error(label ?? "assertion failed");
}

function assertToolCall(
  calls: ToolCall[] | null,
  index: number,
  expected: { name: string; args?: Record<string, unknown> }
): void {
  assert(calls !== null, "expected non-null calls");
  const call = calls[index];
  assert(call !== undefined, `expected call at index ${index}`);
  assertEqual(call.name, expected.name);
  if (expected.args) {
    assertEqual(JSON.stringify(call.args), JSON.stringify(expected.args));
  }
}

// --- URL matching ---
const matchingUrls = [
  "https://z.ai/chat",
  "https://z.ai/api/paas/v4/chat/completions",
  "https://api.z.ai/api/paas/v4/chat/completions",
  "https://www.z.ai/chat",
  "https://chatglm.cn/api/chat/completions",
  "https://chat.chatglm.cn/api/chat",
  "https://api.z.ai/v1/models",
];

for (const url of matchingUrls) {
  test(`matches ${url}`, () => assert(zaiAdapter.match(url), `expected ${url} to match`));
}

const nonMatchingUrls = [
  "https://chat.openai.com/api/chat/completions",
  "https://api.deepseek.com/chat/completions",
  "https://zai.com/api/chat/completions",
];

for (const url of nonMatchingUrls) {
  test(`does not match ${url}`, () => assert(!zaiAdapter.match(url), `expected ${url} to NOT match`));
}

function makeRequest(body: string): InterceptedRequest {
  return {
    id: "1",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timestamp: Date.now(),
    adapterType: "zai",
  };
}

function makeResponse(body: string, status = 200): InterceptedResponse {
  return {
    id: "2",
    requestId: "1",
    status,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body,
    timestamp: Date.now(),
  };
}

// --- transformRequest / system prompt injection ---

test("injects system prompt into request without system message", () => {
  const req = makeRequest(JSON.stringify({ messages: [{ role: "user", content: "hello" }], model: "glm-5.2" }));
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  assert(modified !== undefined);
  const parsed = JSON.parse(modified.body) as { messages: Array<{ role: string; content: string }> };
  assertEqual(parsed.messages[0]?.role, "system");
  assert(parsed.messages[0]?.content.includes("DeckAgent"), "system content missing DeckAgent");
  assertEqual(parsed.messages.length, 2);
});

test("prepends tool prompt before existing system message", () => {
  const req = makeRequest(JSON.stringify({ messages: [{ role: "system", content: "Be helpful." }], model: "glm-5.2" }));
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  const parsed = JSON.parse(modified.body) as { messages: Array<{ role: string; content: string }> };
  assertEqual(parsed.messages[0]?.role, "system");
  assert(parsed.messages[0]?.content.startsWith("You have access to a local machine through DeckAgent."), "tool prompt not prepended");
  assert(parsed.messages[0]?.content.includes("Be helpful."), "original system prompt missing");
});

test("does not duplicate tool prompt when system message already contains DeckAgent", () => {
  const req = makeRequest(JSON.stringify({ messages: [{ role: "system", content: "DeckAgent tools available." }], model: "glm-5.2" }));
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  const parsed = JSON.parse(modified.body) as { messages: Array<{ role: string; content: string }> };
  const deckAgentCount = (parsed.messages[0]?.content.match(/DeckAgent/g) ?? []).length;
  assertEqual(deckAgentCount, 1, "DeckAgent should not be duplicated");
});

test("handles request with array body format", () => {
  const req = makeRequest(JSON.stringify([{ role: "user", content: "hello" }]));
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, req.body, "unsupported array body should be returned unchanged");
});

test("handles empty body gracefully", () => {
  const req = makeRequest("");
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, "");
});

test("handles invalid JSON body gracefully", () => {
  const req = makeRequest("not json");
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, "not json");
});

test("handles request with no messages array", () => {
  const req = makeRequest(JSON.stringify({ model: "glm-5.2", input: "hello" }));
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, req.body);
});

test("handles request with null messages", () => {
  const req = makeRequest(JSON.stringify({ messages: null, model: "glm-5.2" }));
  const modified = zaiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, req.body);
});

// --- transformResponse passthrough ---

test("transformResponse returns response unchanged", () => {
  const req = makeRequest(JSON.stringify({ messages: [] }));
  const res = makeResponse("hello");
  const transformed = zaiAdapter.transformResponse?.(req, res);
  assertEqual(transformed, res);
});

// --- extractToolCalls: OpenAI-compatible non-streaming response ---

test("extracts tool call from OpenAI non-streaming response", () => {
  const body = JSON.stringify({ choices: [{ message: { content: '<<<TOOL>>>{"name":"read_file","args":{"path":"/etc/hosts"}}<<<END>>>' } }] });
  const calls = extractToolCalls(body);
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/etc/hosts" } });
});

test("extracts multiple tool calls from non-streaming response", () => {
  const content = 'x <<<TOOL>>>{"name":"a","args":{"x":1}}<<<END>>> y <<<TOOL>>>{"name":"b","args":{"y":2}}<<<END>>>';
  const body = JSON.stringify({ choices: [{ message: { content } }] });
  const calls = extractToolCalls(body);
  assert(calls !== null);
  assertEqual(calls.length, 2);
  assertToolCall(calls, 0, { name: "a", args: { x: 1 } });
  assertToolCall(calls, 1, { name: "b", args: { y: 2 } });
});

test("extracts tool call from choices.0.message.content", () => {
  const body = JSON.stringify({ choices: [{ message: { content: '<<<TOOL>>>{"name":"execute_command","args":{"command":"ls"}}<<<END>>>' } }] });
  const calls = extractToolCalls(body);
  assertToolCall(calls, 0, { name: "execute_command", args: { command: "ls" } });
});

// --- extractToolCalls: SSE streaming ---

test("extracts tool call from SSE streaming response", () => {
  const chunks = [
    { choices: [{ delta: { content: "Sure" } }] },
    { choices: [{ delta: { content: ", tool: <<<TOOL>>>" } }] },
    { choices: [{ delta: { content: '{"name":"execute_command","args":{"command":"ls"}}<<<END>>> done' } }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\ndata: [DONE]\n";
  const calls = extractToolCalls(body);
  assertToolCall(calls, 0, { name: "execute_command", args: { command: "ls" } });
});

test("extracts tool calls split across multiple SSE chunks", () => {
  const chunks = [
    { choices: [{ delta: { content: '<<<TOOL>>>{"name":"' } }] },
    { choices: [{ delta: { content: 'read_file","args":{"path":"/foo"}}<<<END>>>' } }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\n";
  const calls = extractToolCalls(body);
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/foo" } });
});

test("extracts multiple tool calls from SSE stream", () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"<<<TOOL>>>{\\"name\\":\\"read_file\\",\\"args\\":{\\"path\\":\\"/a\\"}}<<<END>>>"}}]}',
    'data: {"choices":[{"delta":{"content":" and \\n<<<TOOL>>>{\\"name\\":\\"read_file\\",\\"args\\":{\\"path\\":\\"/b\\"}}<<<END>>>"}}]}',
    "data: [DONE]",
  ].join("\n");
  const calls = extractToolCalls(sse);
  assert(calls !== null);
  assertEqual(calls.length, 2);
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/a" } });
  assertToolCall(calls, 1, { name: "read_file", args: { path: "/b" } });
});

test("ignores malformed SSE chunks", () => {
  const sse = [
    "data: not valid json",
    'data: {"choices":[{"delta":{"content":"<<<TOOL>>>{\\"name\\":\\"list_directory\\",\\"args\\":{\\"path\\":\\"/\\"}}<<<END>>>"}}]}',
    "data: [DONE]",
  ].join("\n");
  const calls = extractToolCalls(sse);
  assertToolCall(calls, 0, { name: "list_directory", args: { path: "/" } });
});

test("handles SSE with mixed valid and invalid data lines", () => {
  const sse = [
    "data: not json",
    "data: {invalid}",
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    "data:",
    'data: {"choices":[{"delta":{"content":"<<<TOOL>>>{\\"name\\":\\"get_environment\\",\\"args\\":{}}<<<END>>>"}}]}',
  ].join("\n");
  const calls = extractToolCalls(sse);
  assertToolCall(calls, 0, { name: "get_environment", args: {} });
});

test("handles SSE without trailing [DONE]", () => {
  const sse = 'data: {"choices":[{"delta":{"content":"<<<TOOL>>>{\\"name\\":\\"read_file\\",\\"args\\":{\\"path\\":\\"/x\\"}}<<<END>>>"}}]}';
  const calls = extractToolCalls(sse);
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/x" } });
});

test("returns null when SSE stream has no tool markers", () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hello, how can I help?"}}]}',
    "data: [DONE]",
  ].join("\n");
  const calls = extractToolCalls(sse);
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

// --- Edge cases for tool extraction ---

test("returns null when no tool pattern present in non-streaming response", () => {
  const res = makeResponse(JSON.stringify({ choices: [{ message: { content: "just text" } }] }));
  const calls = extractToolCalls(res.body);
  assertEqual(calls, null);
});

test("returns null for malformed tool JSON inside pattern", () => {
  const res = makeResponse(JSON.stringify({ choices: [{ message: { content: "<<<TOOL>>>not valid json<<<END>>>" } }] }));
  const calls = extractToolCalls(res.body);
  assertEqual(calls, null);
});

test("extracts from plain text response", () => {
  const body = `some text <<<TOOL>>>{"name":"list_directory","args":{"path":"/"}}<<<END>>> more`;
  const calls = extractToolCalls(body);
  assertToolCall(calls, 0, { name: "list_directory", args: { path: "/" } });
});

test("handles empty response body", () => {
  const calls = extractToolCalls("");
  assertEqual(calls, null);
});

test("handles malformed JSON response body", () => {
  const calls = extractToolCalls("not valid json");
  assertEqual(calls, null);
});

test("handles tool block with single quotes", () => {
  const calls = extractToolCalls("<<<TOOL>>>{'name':'read_file','args':{'path':'/etc/hosts'}}<<<END>>>");
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/etc/hosts" } });
});

test("handles tool block with tool field", () => {
  const calls = extractToolCalls('<<<TOOL>>>{"tool":"write_file","args":{"path":"/tmp/x"}}<<<END>>>');
  assertToolCall(calls, 0, { name: "write_file", args: { path: "/tmp/x" } });
});

test("returns null for malformed tool block", () => {
  const calls = extractToolCalls('<<<TOOL>>>{invalid json<<<END>>>');
  assertEqual(calls, null);
});

test("handles nested braces in args", () => {
  const calls = extractToolCalls('<<<TOOL>>>{"name":"execute_command","args":{"command":"echo {a:1}"}}<<<END>>>');
  assertToolCall(calls, 0, { name: "execute_command", args: { command: "echo {a:1}" } });
});

test("extracts multiple tool calls from plain text", () => {
  const calls = extractToolCalls(
    '<<<TOOL>>>{"name":"read_file","args":{"path":"/a"}}<<<END>>><<<TOOL>>>{"name":"read_file","args":{"path":"/b"}}<<<END>>>'
  );
  assert(calls !== null);
  assertEqual(calls.length, 2);
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/a" } });
  assertToolCall(calls, 1, { name: "read_file", args: { path: "/b" } });
});

// --- appendToolResult ---

test("appends tool result to messages", () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }], model: "glm-5.2" });
  const result = appendToolResult(body, "tool output here");
  const parsed = JSON.parse(result) as { messages: Array<{ role: string; content: string }> };
  const last = parsed.messages[parsed.messages.length - 1];
  assertEqual(last?.role, "assistant");
  assert(last?.content.includes("tool output here"), "tool output not in content");
  assert(last?.content.startsWith("<TOOL_RESULT>"), "content missing TOOL_RESULT wrapper");
});

test("appendToolResult returns body unchanged when no messages array", () => {
  const body = JSON.stringify({ input: "hello" });
  const result = appendToolResult(body, "output");
  assertEqual(result, body);
});

test("appendToolResult handles invalid JSON", () => {
  const result = appendToolResult("not json", "output");
  assertEqual(result, "not json");
});

test("appendToolResult handles empty body", () => {
  const result = appendToolResult("", "output");
  assertEqual(result, "");
});

// --- Summary ---
console.log(`\n${total - failures}/${total} tests passed`);
if (failures > 0) {
  process.exit(1);
}
