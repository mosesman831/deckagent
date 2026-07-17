import { qwenAdapter, extractToolCalls, appendToolResult } from "../src/adapters/qwen.js";

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(`assertion failed: ${label}`);
}

// Match URLs
assert(qwenAdapter.match("https://chat.qwen.ai/api/chat/completions"), "qwen chat completions");
assert(qwenAdapter.match("https://qwen.ai/api/v1/chat"), "qwen root domain");
assert(qwenAdapter.match("https://chat.qwenlm.ai/api/conversations"), "qwenlm chat");
assert(qwenAdapter.match("https://tongyi.aliyun.com/qianwen/api/messages"), "tongyi qianwen");
assert(!qwenAdapter.match("https://chat.openai.com/api/chat/completions"), "not openai");

// Modify request
const requestBody = JSON.stringify({
  messages: [{ role: "user", content: "hello" }],
  model: "qwen-max",
  stream: true,
});
const modified = qwenAdapter.transformRequest({
  id: "1",
  url: "https://chat.qwen.ai/api/chat/completions",
  method: "POST",
  headers: {},
  body: requestBody,
  timestamp: Date.now(),
  adapterType: "qwen",
});
assert(typeof modified === "object" && "body" in modified && modified.body.includes("DeckAgent"), "tool prompt injected");

// Extract non-streaming Qwen response
const qwenResponse = JSON.stringify({
  output: {
    text: 'I will use a tool. <<<TOOL>>>{"name":"read_file","args":{"path":"/etc/hosts"}}<<<END>>>',
  },
});
const calls = extractToolCalls(qwenResponse);
assert(calls !== null && calls[0]?.name === "read_file", "qwen non-streaming tool call");
assert(
  calls !== null && (calls[0]?.args as { path: string }).path === "/etc/hosts",
  "qwen args parsed"
);

// Extract OpenAI-style streaming response
const sseResponse = `data: {"choices":[{"delta":{"content":"<<<TOOL>>>"}}]}\n\ndata: {"choices":[{"delta":{"content":"{\\"name\\":\\"list_directory\\",\\"args\\":{\\"path\\":\\"/home\\"}}<<<END>>>"}}]}\n\ndata: [DONE]`;
const streamCalls = extractToolCalls(sseResponse);
assert(streamCalls !== null && streamCalls[0]?.name === "list_directory", "sse tool call");

// Append result
const appended = appendToolResult(requestBody, "file contents");
assert(appended.includes("file contents"), "tool result appended");

console.log("qwen adapter smoke test passed");
