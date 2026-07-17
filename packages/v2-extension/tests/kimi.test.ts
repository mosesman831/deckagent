import type { InterceptedRequest, InterceptedResponse, ToolCall } from "../src/adapters/types.js";
import { kimiAdapter, extractToolCalls, appendToolResult } from "../src/adapters/kimi.js";

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
  if (calls === null) throw new Error("expected non-null calls");
  const call = calls[index];
  assert(call !== undefined, `expected call at index ${index}`);
  assertEqual(call.name, expected.name);
  if (expected.args) {
    assertEqual(JSON.stringify(call.args), JSON.stringify(expected.args));
  }
}

// --- URL matching ---
const matchingUrls = [
  "https://kimi.com/api/chat/completions",
  "https://kimi.com/v1/chat/completions",
  "https://api.moonshot.ai/v1/chat/completions",
  "https://moonshot.ai/v1/chat/completions",
  "https://chat.kimi.com/api/chat",
];

for (const url of matchingUrls) {
  test(`matches ${url}`, () => assert(kimiAdapter.match(url), `expected ${url} to match`));
}

const nonMatchingUrls = [
  "https://chat.openai.com/api/chat/completions",
  "https://api.deepseek.com/chat/completions",
  "https://api.qwen.com/chat/completions",
];

for (const url of nonMatchingUrls) {
  test(`does not match ${url}`, () => assert(!kimiAdapter.match(url), `expected ${url} to NOT match`));
}

function makeRequest(body: string): InterceptedRequest {
  return {
    id: "1",
    url: "https://api.moonshot.ai/v1/chat/completions",
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timestamp: Date.now(),
    adapterType: "kimi",
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
  const req = makeRequest(JSON.stringify({ messages: [{ role: "user", content: "hello" }], model: "kimi-k2.7" }));
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  assert(modified !== undefined);
  const parsed = JSON.parse(modified.body) as { messages: Array<{ role: string; content: string }> };
  assertEqual(parsed.messages[0]?.role, "system");
  assert(parsed.messages[0]?.content.includes("DeckAgent"), "system content missing DeckAgent");
  assertEqual(parsed.messages.length, 2);
});

test("prepends tool prompt before existing system message", () => {
  const req = makeRequest(JSON.stringify({ messages: [{ role: "system", content: "Be helpful." }], model: "kimi-k2.7" }));
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  const parsed = JSON.parse(modified.body) as { messages: Array<{ role: string; content: string }> };
  assertEqual(parsed.messages[0]?.role, "system");
  assert(parsed.messages[0]?.content.startsWith("You have access to a local machine through DeckAgent."), "tool prompt not prepended");
  assert(parsed.messages[0]?.content.includes("Be helpful."), "original system prompt missing");
});

test("does not duplicate tool prompt when system message already contains DeckAgent", () => {
  const req = makeRequest(JSON.stringify({ messages: [{ role: "system", content: "DeckAgent tools available." }], model: "kimi-k2.7" }));
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  const parsed = JSON.parse(modified.body) as { messages: Array<{ role: string; content: string }> };
  const deckAgentCount = (parsed.messages[0]?.content.match(/DeckAgent/g) ?? []).length;
  assertEqual(deckAgentCount, 1, "DeckAgent should not be duplicated");
});

test("handles request with array body format", () => {
  const req = makeRequest(JSON.stringify([{ messages: [{ role: "user", content: "hello" }], model: "kimi-k2.7" }]));
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, req.body, "unsupported array body should be returned unchanged");
});

test("handles empty body gracefully", () => {
  const req = makeRequest("");
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, "");
});

test("handles invalid JSON body gracefully", () => {
  const req = makeRequest("not json");
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, "not json");
});

test("handles request with no messages array", () => {
  const req = makeRequest(JSON.stringify({ model: "kimi-k2.7", input: "hello" }));
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, req.body);
});

test("handles request with null messages", () => {
  const req = makeRequest(JSON.stringify({ messages: null, model: "kimi-k2.7" }));
  const modified = kimiAdapter.transformRequest?.(req) as InterceptedRequest;
  assertEqual(modified.body, req.body);
});

// --- transformResponse passthrough ---

test("transformResponse returns response unchanged", () => {
  const req = makeRequest(JSON.stringify({ messages: [] }));
  const res = makeResponse("hello");
  const transformed = kimiAdapter.transformResponse?.(req, res);
  assertEqual(transformed, res);
});

// --- extractToolCalls: non-streaming OpenAI-compatible response ---

test("extracts tool call from non-streaming response", () => {
  const body = JSON.stringify({ choices: [{ message: { content: '<<<TOOL>>>{"name":"read_file","args":{"path":"/etc/hosts"}}<<<END>>>' } }] });
  const calls = extractToolCalls(body);
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/etc/hosts" } });
});

test("extracts tool call from choices.0.text", () => {
  const body = JSON.stringify({ choices: [{ text: '<<<TOOL>>>{"name":"get_environment","args":{}}<<<END>>>' }] });
  const calls = extractToolCalls(body);
  if (calls === null) throw new Error("expected non-null calls");
  assertToolCall(calls, 0, { name: "get_environment", args: {} });
});

// --- extractToolCalls: SSE streaming ---

test("extracts tool call from SSE chunks split mid-tool", () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"<<<TOOL>>>"}}]}',
    'data: {"choices":[{"delta":{"content":"{\\"name\\":\\"browser_navigate\\",\\"args\\":{\\"url\\":\\"https://example.com\\"}}<<<END>>>"}}]}',
    "data: [DONE]",
  ].join("\n\n");
  const calls = extractToolCalls(sse);
  if (calls === null) throw new Error("expected non-null calls");
  assertToolCall(calls, 0, { name: "browser_navigate", args: { url: "https://example.com" } });
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

test("returns null for non-streaming response without tool markers", () => {
  const calls = extractToolCalls(JSON.stringify({ choices: [{ message: { content: "Hello there" } }] }));
  assertEqual(calls, null);
});

// --- Edge cases for tool extraction ---

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

test("handles plain text tool block", () => {
  const calls = extractToolCalls('Some text before. <<<TOOL>>>{"name":"read_file","args":{"path":"/a"}}<<<END>>> After.');
  assertToolCall(calls, 0, { name: "read_file", args: { path: "/a" } });
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
  const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }], model: "kimi-k2.7" });
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

// --- Summary ---
console.log(`\n${total - failures}/${total} tests passed`);
if (failures > 0) {
  process.exit(1);
}
