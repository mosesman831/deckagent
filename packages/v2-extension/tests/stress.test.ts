import { createServer, type Server } from "node:http";
import type { ChatAdapter, InterceptedRequest } from "../src/adapters/types.js";
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

const adapterModules: Record<string, { extractToolCalls: (content: string) => unknown[] | null; appendToolResult: (body: string, content: string) => string }> = {
  deepseek: await import("../src/adapters/deepseek.js"),
  qwen: await import("../src/adapters/qwen.js"),
  kimi: await import("../src/adapters/kimi.js"),
  zai: await import("../src/adapters/zai.js"),
};

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

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;':\",./<>?";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function randomMalformedJson(): string {
  const templates = [
    "{",
    "}",
    "[",
    "]",
    "{name: ",
    '{"name": }',
    '{"name": "read_file", "args": }',
    "not json",
    "",
    "null",
    "undefined",
    '{"name":"read_file","args":{"path":\'/etc/hosts\'}}',
    "<<<TOOL>>>",
    "<<<END>>>",
    "<<<TOOL>>><<<END>>>",
    "{\"name\": \"read_file\", \"args\": {\"path\": \"/etc/hosts\"",
    "[1, 2, 3]",
    "{\"messages\": \"not an array\"}",
    "{\"messages\": null}",
    "{\"messages\": [{\"role\": \"user\", \"content\": 123}]}",
  ];
  const base = templates[randomInt(0, templates.length - 1)];
  const noise = randomString(randomInt(0, 50));
  return Math.random() > 0.5 ? base + noise : noise + base;
}

function makeRequest(adapter: ChatAdapter, url: string, body: unknown): InterceptedRequest {
  return {
    id: "req-1",
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timestamp: Date.now(),
    adapterType: adapter.name,
  };
}

interface MockServer {
  server: Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
  setResponse: (path: string, response: { status?: number; body: string; headers?: Record<string, string>; delay?: number; times?: number }) => void;
  setStreamResponse: (path: string, chunks: string[], times?: number) => void;
}

function createMockServer(): Promise<MockServer> {
  const routes = new Map<string, Array<{ status: number; body: string; headers: Record<string, string>; delay?: number }>>();
  const streams = new Map<string, Array<{ chunks: string[] }>>();

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      const streamQueue = streams.get(url.pathname);
      if (streamQueue && streamQueue.length > 0) {
        const streamEntry = streamQueue.shift()!;
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

      const routeQueue = routes.get(url.pathname);
      if (routeQueue && routeQueue.length > 0) {
        const route = routeQueue.shift()!;
        const send = () => {
          res.writeHead(route.status, route.headers);
          res.end(route.body);
        };
        if (route.delay) {
          setTimeout(send, route.delay);
        } else {
          send();
        }
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
        close: () => new Promise<void>((r) => server.close(() => r())),
        setResponse(path, response) {
          const queue = routes.get(path) ?? [];
          const entry = {
            status: response.status ?? 200,
            body: response.body,
            headers: { "content-type": "application/json", ...(response.headers ?? {}) },
            delay: response.delay,
          };
          for (let i = 0; i < (response.times ?? 1); i++) {
            queue.push(entry);
          }
          routes.set(path, queue);
        },
        setStreamResponse(path, chunks, times = 1) {
          const queue = streams.get(path) ?? [];
          for (let i = 0; i < times; i++) {
            queue.push({ chunks });
          }
          streams.set(path, queue);
        },
      });
    });
  });
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; text: string }> {
  const res = await fetch(url, init);
  return { status: res.status, text: await res.text() };
}

(async () => {
  const mock = await createMockServer();
  console.log("Stress / fuzz adapter tests");

  await test("all adapters handle 100 random malformed inputs without crashing", async () => {
    for (let i = 0; i < 100; i++) {
      const adapter = Object.values(ADAPTERS)[i % 4];
      const mod = adapterModules[adapter.name];
      const malformed = randomMalformedJson();

      // Should not throw on transformRequest
      const request = makeRequest(adapter, `${mock.baseUrl}/v1/chat/completions`, { messages: [{ role: "user", content: "hi" }] });
      const transformed = adapter.transformRequest?.(request) as InterceptedRequest;
      assertTruthy(transformed);

      // Should not throw on extractToolCalls
      const calls = mod.extractToolCalls(malformed);
      assertTrue(calls === null || Array.isArray(calls));

      // Should not throw on appendToolResult
      const result = mod.appendToolResult(malformed, "tool output");
      assertTrue(typeof result === "string");
    }
  });

  await test("concurrent requests are handled independently", async () => {
    const path = "/v1/chat/completions";
    const adapter = DeepSeekAdapter;
    const toolBlock = `<<<TOOL>>>{"name":"get_environment","args":{}}<<<END>>>`;
    for (let i = 0; i < 5; i++) {
      mock.setResponse(path, { body: JSON.stringify({ choices: [{ message: { content: toolBlock } }] }) });
    }

    const requests = Array.from({ length: 5 }, (_, i) =>
      makeRequest(adapter, `${mock.baseUrl}${path}`, { messages: [{ role: "user", content: `msg-${i}` }] })
    );

    const transformed = requests.map((r) => adapter.transformRequest?.(r) as InterceptedRequest);
    const responses = await Promise.all(
      transformed.map((t) =>
        fetchText(t.url, { method: t.method, headers: t.headers, body: t.body })
      )
    );

    for (const res of responses) {
      assertEqual(res.status, 200);
      const calls = adapterModules.deepseek.extractToolCalls(res.text);
      assertTruthy(calls);
      assertEqual(calls.length, 1);
      assertEqual(calls[0].name, "get_environment");
    }
  });

  await test("very large response body is parsed correctly", () => {
    const adapter = qwenAdapter;
    const mod = adapterModules.qwen;
    const largeContent = "x".repeat(1024 * 1024) + `<<<TOOL>>>{"name":"list_directory","args":{"path":"/"}}<<<END>>>` + "y".repeat(1024 * 1024);
    const body = JSON.stringify({ choices: [{ message: { content: largeContent } }] });
    const calls = mod.extractToolCalls(body);
    assertTruthy(calls);
    assertEqual(calls.length, 1);
    assertEqual(calls[0].name, "list_directory");
  });

  await test("very large request body does not break transformRequest", () => {
    const adapter = kimiAdapter;
    const largeMessages = Array.from({ length: 1000 }, (_, i) => ({
      role: "user",
      content: `message ${i}: ` + "x".repeat(1000),
    }));
    const request = makeRequest(adapter, `${mock.baseUrl}/v1/chat/completions`, { messages: largeMessages });
    const transformed = adapter.transformRequest?.(request) as InterceptedRequest;
    assertTruthy(transformed);
    const parsed = JSON.parse(transformed.body) as { messages: unknown[] };
    assertEqual(parsed.messages.length, 1001);
    assertEqual((parsed.messages[0] as { role: string }).role, "system");
  });

  await test("tool markers split across many SSE chunks are reassembled", () => {
    const adapter = zaiAdapter;
    const mod = adapterModules.zai;
    const toolBlock = `{"name":"browser_navigate","args":{"url":"https://example.com"}}`;
    const full = `<<<TOOL>>>${toolBlock}<<<END>>>`;
    const chars = full.split("");
    const chunks: string[] = [];
    while (chars.length > 0) {
      const size = randomInt(1, Math.min(10, chars.length));
      const slice = chars.splice(0, size).join("");
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: slice } }] })}\n\n`);
    }
    chunks.push("data: [DONE]\n\n");

    const sse = chunks.join("");
    const calls = mod.extractToolCalls(sse);
    assertTruthy(calls);
    assertEqual(calls.length, 1);
    assertEqual(calls[0].name, "browser_navigate");
    assertEqual(calls[0].args, { url: "https://example.com" });
  });

  await test("split tool markers across chunks for all adapters", () => {
    for (const adapter of Object.values(ADAPTERS)) {
      const mod = adapterModules[adapter.name];
      const toolBlock = `{"name":"read_file","args":{"path":"/foo/bar"}}`;
      const full = `prefix <<<TOOL>>>${toolBlock}<<<END>>> suffix`;
      const mid = Math.floor(full.length / 2);
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(0, mid) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(mid) } }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      const calls = mod.extractToolCalls(sse);
      assertTruthy(calls, `expected tool calls for ${adapter.name}`);
      assertEqual(calls.length, 1);
      assertEqual(calls[0].name, "read_file");
    }
  });

  await test("empty and whitespace-only inputs return null", () => {
    for (const adapter of Object.values(ADAPTERS)) {
      const mod = adapterModules[adapter.name];
      assertEqual(mod.extractToolCalls(""), null);
      assertEqual(mod.extractToolCalls("   "), null);
      assertEqual(mod.extractToolCalls("\n\n"), null);
    }
  });

  await test("appendToolResult handles empty and malformed bodies gracefully", () => {
    for (const adapter of Object.values(ADAPTERS)) {
      const mod = adapterModules[adapter.name];
      assertEqual(mod.appendToolResult("", "result"), "");
      assertEqual(mod.appendToolResult("not json", "result"), "not json");
      assertEqual(mod.appendToolResult(JSON.stringify({}), "result"), JSON.stringify({}));
    }
  });

  await test("concurrent streaming requests do not interleave", async () => {
    const adapter = kimiAdapter;
    const path = "/v1/chat/completions";
    const responses = [
      { n: 0, tool: `<<<TOOL>>>{"name":"read_file","args":{"path":"/a"}}<<<END>>>` },
      { n: 1, tool: `<<<TOOL>>>{"name":"read_file","args":{"path":"/b"}}<<<END>>>` },
      { n: 2, tool: `<<<TOOL>>>{"name":"read_file","args":{"path":"/c"}}<<<END>>>` },
    ];
    for (const r of responses) {
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: r.tool.slice(0, 10) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: r.tool.slice(10) } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      mock.setStreamResponse(path, chunks);
    }

    const transformed = responses.map((r) =>
      adapter.transformRequest?.(
        makeRequest(adapter, `${mock.baseUrl}${path}`, { messages: [{ role: "user", content: `c-${r.n}` }] })
      ) as InterceptedRequest
    );

    const results = await Promise.all(
      transformed.map((t) => fetchText(t.url, { method: t.method, headers: t.headers, body: t.body }))
    );

    for (let i = 0; i < results.length; i++) {
      assertEqual(results[i].status, 200);
      const calls = adapterModules.kimi.extractToolCalls(results[i].text);
      assertTruthy(calls);
      assertEqual(calls.length, 1);
      assertEqual(calls[0].args, { path: `/${String.fromCharCode(97 + i)}` });
    }
  });

  await test("adapter matching is robust against malformed URLs", () => {
    const malformedUrls = ["", "not-a-url", "///", "http://", "https://", "ftp://deepseek.com/chat"];
    for (const url of malformedUrls) {
      for (const adapter of Object.values(ADAPTERS)) {
        const result = adapter.match(url);
        assertTrue(typeof result === "boolean");
      }
    }
  });

  await mock.close();

  console.log(`\n${total - failed}/${total} tests passed`);
  if (failed > 0) process.exit(1);
})();
