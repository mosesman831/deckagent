import { createServer, type Server } from "node:http";
import type { ChatAdapter, InterceptedRequest, InterceptedResponse } from "../src/adapters/types.js";
import { DeepSeekAdapter } from "../src/adapters/deepseek.js";
import { qwenAdapter } from "../src/adapters/qwen.js";
import { kimiAdapter } from "../src/adapters/kimi.js";
import { zaiAdapter } from "../src/adapters/zai.js";

const ADAPTERS: Record<string, ChatAdapter> = {
  deepseek: DeepSeekAdapter,
  qwen: qwenAdapter,
  kimi: kimiAdapter,
  zai: zaiAdapter,
};

let adapterModules: Record<string, { extractToolCalls: (content: string) => unknown[] | null; appendToolResult: (body: string, content: string) => string }> = {} as Record<string, { extractToolCalls: (content: string) => unknown[] | null; appendToolResult: (body: string, content: string) => string }>;

let total = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    await fn();
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

function assertTruthy<T>(value: T | null | undefined, msg?: string): T {
  if (value == null) throw new Error(msg || "expected truthy value");
  return value;
}

interface CallLog {
  url: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface MockServer {
  server: Server;
  port: number;
  baseUrl: string;
  calls: CallLog[];
  close: () => Promise<void>;
  clearCalls: () => void;
  setResponse: (path: string, response: { status?: number; body: string; headers?: Record<string, string>; times?: number }) => void;
  setStreamResponse: (path: string, chunks: string[], remaining?: number) => void;
}

function createMockServer(): Promise<MockServer> {
  const calls: CallLog[] = [];
  const routes = new Map<string, { status: number; body: string; headers: Record<string, string>; remaining: number }>();
  const streams = new Map<string, { chunks: string[]; remaining: number }>();

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      calls.push({
        url: url.pathname,
        method: req.method,
        headers: { ...req.headers },
        body,
      });

      const streamEntry = streams.get(url.pathname);
      if (streamEntry && streamEntry.remaining > 0) {
        streamEntry.remaining--;
        if (streamEntry.remaining <= 0) streams.delete(url.pathname);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of streamEntry.chunks) {
          res.write(chunk);
        }
        res.end();
        return;
      }

      const route = routes.get(url.pathname);
      if (route && route.remaining > 0) {
        route.remaining--;
        if (route.remaining <= 0) routes.delete(url.pathname);
        res.writeHead(route.status, route.headers);
        res.end(route.body);
        return;
      }

      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html>
<html>
  <head><title>DeckAgent E2E</title></head>
  <body>
    <h1>DeckAgent E2E Mock</h1>
    <script>
      async function callApi(path, body) {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, text };
      }
      window.callApi = callApi;
    </script>
  </body>
</html>`);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        baseUrl,
        calls,
        clearCalls: () => {
          calls.length = 0;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
        setResponse(path, response) {
          routes.set(path, {
            status: response.status ?? 200,
            body: response.body,
            headers: { "content-type": "application/json", ...(response.headers ?? {}) },
            remaining: 1,
          });
        },
        setStreamResponse(path, chunks) {
          streams.set(path, { chunks, remaining: 1 });
        },
      });
    });
  });
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(url, init);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function makeRequest(adapter: ChatAdapter, baseUrl: string, body: unknown): InterceptedRequest {
  return {
    id: "req-1",
    url: `${baseUrl}${adapter.name === "zai" ? "/api/paas/v4/chat/completions" : "/v1/chat/completions"}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timestamp: Date.now(),
    adapterType: adapter.name,
  };
}

function makeResponse(body: string): InterceptedResponse {
  return {
    id: "res-1",
    requestId: "req-1",
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body,
    timestamp: Date.now(),
  };
}

function nonStreamingContent(toolBlock: string): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content: toolBlock } }],
  });
}

function streamingChunks(toolBlock: string): string[] {
  const prefix = "I'll use a tool: ";
  const text = `${prefix}${toolBlock}`;
  const mid = Math.floor(text.length / 2);
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, mid) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(mid) } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

(async () => {
  adapterModules = {
    deepseek: await import("../src/adapters/deepseek.js"),
    qwen: await import("../src/adapters/qwen.js"),
    kimi: await import("../src/adapters/kimi.js"),
    zai: await import("../src/adapters/zai.js"),
  };

  const mock = await createMockServer();

  console.log("E2E mock server integration tests");

  await test("server serves HTML page", async () => {
    const res = await fetchText(`${mock.baseUrl}/`);
    assertEqual(res.status, 200);
    assertTrue(res.text.includes("DeckAgent E2E Mock"));
  });

  await test("server records mock API calls", async () => {
    mock.clearCalls();
    mock.setResponse("/v1/chat/completions", { body: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) });
    const res = await fetchText(`${mock.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    assertEqual(res.status, 200);
    assertEqual(mock.calls.length, 1);
    assertEqual(mock.calls[0].url, "/v1/chat/completions");
  });

  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    await test(`${name}: transformRequest injects tool system prompt`, () => {
      const request = makeRequest(adapter, mock.baseUrl, { messages: [{ role: "user", content: "hi" }] });
      const transformed = adapter.transformRequest?.(request) as InterceptedRequest;
      assertTruthy(transformed);
      assertTrue(transformed.body.includes("DeckAgent"), "tool system prompt not injected");
      assertTrue(transformed.body.includes("<<<TOOL>>>"), "prompt missing tool marker example");
    });

    await test(`${name}: full non-streaming tool call cycle`, async () => {
      const path = adapter.name === "zai" ? "/api/paas/v4/chat/completions" : "/v1/chat/completions";
      const toolBlock = `<<<TOOL>>>{"name":"read_file","args":{"path":"/etc/hosts"}}<<<END>>>`;
      mock.setResponse(path, { body: nonStreamingContent(toolBlock) });

      const request = makeRequest(adapter, mock.baseUrl, { messages: [{ role: "user", content: "read a file" }] });
      const transformedReq = adapter.transformRequest?.(request) as InterceptedRequest;

      const res = await fetchText(transformedReq.url, {
        method: transformedReq.method,
        headers: transformedReq.headers,
        body: transformedReq.body,
      });

      assertEqual(res.status, 200);
      const interceptedRes = makeResponse(res.text);
      const finalRes = adapter.transformResponse?.(transformedReq, interceptedRes) as InterceptedResponse;
      assertTruthy(finalRes);

      const mod = adapterModules[adapter.name];
      const calls = mod.extractToolCalls(finalRes.body) as unknown[] | null;
      assertTruthy(calls, "expected tool calls");
      assertEqual(calls.length, 1);
      assertEqual((calls[0] as { name: string }).name, "read_file");
      assertEqual((calls[0] as { args: unknown }).args, { path: "/etc/hosts" });

      const resultBody = mod.appendToolResult(transformedReq.body, "file contents here");
      const parsed = JSON.parse(resultBody) as { messages: Array<{ role: string; content: string }> };
      const last = parsed.messages[parsed.messages.length - 1];
      assertEqual(last.role, "assistant");
      assertTrue(last.content.includes("file contents here"));
      assertTrue(last.content.startsWith("<TOOL_RESULT>"));
    });

    await test(`${name}: full streaming tool call cycle`, async () => {
      const path = adapter.name === "zai" ? "/api/paas/v4/chat/completions" : "/v1/chat/completions";
      const toolBlock = `<<<TOOL>>>{"name":"execute_command","args":{"command":"ls"}}<<<END>>>`;
      mock.setStreamResponse(path, streamingChunks(toolBlock));

      const request = makeRequest(adapter, mock.baseUrl, { messages: [{ role: "user", content: "run a command" }], stream: true });
      const transformedReq = adapter.transformRequest?.(request) as InterceptedRequest;

      const res = await fetchText(transformedReq.url, {
        method: transformedReq.method,
        headers: transformedReq.headers,
        body: transformedReq.body,
      });

      assertEqual(res.status, 200);
      assertTrue((res.headers.get("content-type") ?? "").includes("text/event-stream"));

      const interceptedRes = makeResponse(res.text);
      const finalRes = adapter.transformResponse?.(transformedReq, interceptedRes) as InterceptedResponse;
      assertTruthy(finalRes);

      const mod = adapterModules[adapter.name];
      const calls = mod.extractToolCalls(finalRes.body) as unknown[] | null;
      assertTruthy(calls, "expected streaming tool calls");
      assertEqual(calls.length, 1);
      assertEqual((calls[0] as { name: string }).name, "execute_command");
      assertEqual((calls[0] as { args: unknown }).args, { command: "ls" });

      const resultBody = mod.appendToolResult(transformedReq.body, "output lines");
      const parsed = JSON.parse(resultBody) as { messages: Array<{ role: string; content: string }> };
      const last = parsed.messages[parsed.messages.length - 1];
      assertEqual(last.role, "assistant");
      assertTrue(last.content.includes("output lines"));
    });
  }

  await test("tool system prompt is injected before existing system message", () => {
    for (const adapter of Object.values(ADAPTERS)) {
      const request = makeRequest(adapter, mock.baseUrl, { messages: [{ role: "system", content: "Be helpful." }] });
      const transformed = adapter.transformRequest?.(request) as InterceptedRequest;
      const parsed = JSON.parse(transformed.body) as { messages: Array<{ role: string; content: string }> };
      assertEqual(parsed.messages[0].role, "system");
      assertTrue(parsed.messages[0].content.startsWith("You have access to a local machine through DeckAgent."));
      assertTrue(parsed.messages[0].content.includes("Be helpful."));
    }
  });

  await test("appendToolResult appends result for all adapters", () => {
    for (const adapter of Object.values(ADAPTERS)) {
      const mod = adapterModules[adapter.name];
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const result = mod.appendToolResult(body, "done");
      const parsed = JSON.parse(result) as { messages: Array<{ role: string; content: string }> };
      assertEqual(parsed.messages.length, 2);
      assertEqual(parsed.messages[1].role, "assistant");
      assertTrue(parsed.messages[1].content.includes("done"));
    }
  });

  await test("server call log contains transformed body with tool prompt", async () => {
    mock.clearCalls();
    mock.setResponse("/v1/chat/completions", { body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) });
    const adapter = DeepSeekAdapter;
    const request = makeRequest(adapter, mock.baseUrl, { messages: [{ role: "user", content: "hi" }] });
    const transformed = adapter.transformRequest?.(request) as InterceptedRequest;
    await fetchText(transformed.url, {
      method: transformed.method,
      headers: transformed.headers,
      body: transformed.body,
    });
    const ourCalls = mock.calls.filter((c) => c.url === "/v1/chat/completions");
    assertEqual(ourCalls.length, 1);
    const parsed = JSON.parse(ourCalls[0].body) as { messages: Array<{ role: string; content: string }> };
    assertEqual(parsed.messages[0].role, "system");
    assertTrue(parsed.messages[0].content.includes("DeckAgent"));
  });

  await mock.close();

  console.log(`\n${total - failed}/${total} tests passed`);
  if (failed > 0) process.exit(1);
})();
