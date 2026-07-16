import "./dom-test-bootstrap.js";
import type {
  AdapterMessage,
  InterceptedRequest,
  InterceptedResponse,
} from "../src/adapters/types.js";
import {
  ADAPTERS,
} from "../src/adapters/index.js";
import {
  installFetchMonkeyPatch,
  createReportFn,
  setupContentScript,
  pickAdapter,
  readRequestBody,
} from "../src/lib/fetch-patch.js";

let total = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => console.log(`  ✓ ${name}`))
        .catch((err) => {
          failed++;
          console.error(`  ✗ ${name}`);
          console.error(`    ${err instanceof Error ? err.message : String(err)}`);
        });
    } else {
      console.log(`  ✓ ${name}`);
    }
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

function createMockChromeRuntime() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const connectListeners: Array<(port: MockPort) => void> = [];

  const mockRuntime = {
    onMessage: {
      addListener(fn: (message: unknown) => void) {
        messageListeners.push(fn);
      },
    },
    onConnect: {
      addListener(fn: (port: MockPort) => void) {
        connectListeners.push(fn);
      },
    },
  };

  return { mockRuntime, messageListeners, connectListeners };
}

interface MockPort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void; listeners: ((msg: unknown) => void)[] };
  onDisconnect: { addListener: (fn: () => void) => void; listeners: (() => void)[] };
  postMessage: (message: unknown) => void;
  messages: unknown[];
}

function createMockPort(): MockPort {
  const port: MockPort = {
    onMessage: { addListener: () => void 0, listeners: [] },
    onDisconnect: { addListener: () => void 0, listeners: [] },
    postMessage: () => void 0,
    messages: [],
  };
  port.onMessage.addListener = (fn) => port.onMessage.listeners.push(fn);
  port.onDisconnect.addListener = (fn) => port.onDisconnect.listeners.push(fn);
  port.postMessage = (message) => port.messages.push(message);
  return port;
}

// ---- Tests ----

console.log("Content script fetch monkey-patch integration tests");

test("adapter index registers deepseek, qwen, kimi, and zai", () => {
  assertEqual(ADAPTERS.length, 4);
  const names = ADAPTERS.map((a) => a.name);
  assertTrue(names.includes("deepseek"));
  assertTrue(names.includes("qwen"));
  assertTrue(names.includes("kimi"));
  assertTrue(names.includes("zai"));
});

test("pickAdapter selects Z.ai for z.ai / chatglm URLs", () => {
  assertEqual(pickAdapter("https://chat.z.ai/api/chat", ADAPTERS)?.name, "zai");
  assertEqual(pickAdapter("https://z.ai/api/chat", ADAPTERS)?.name, "zai");
  assertEqual(pickAdapter("https://api.z.ai/v1/chat/completions", ADAPTERS)?.name, "zai");
  assertEqual(pickAdapter("https://chatglm.cn/api/chat", ADAPTERS)?.name, "zai");
});

test("pickAdapter selects Kimi for kimi URLs", () => {
  assertEqual(pickAdapter("https://kimi.com/api/chat/completions", ADAPTERS)?.name, "kimi");
  assertEqual(pickAdapter("https://api.moonshot.ai/v1/chat/completions", ADAPTERS)?.name, "kimi");
});

test("pickAdapter selects DeepSeek for deepseek URLs", () => {
  assertEqual(pickAdapter("https://chat.deepseek.com/api/chat", ADAPTERS)?.name, "deepseek");
  assertEqual(pickAdapter("https://deepseek.com/api/chat", ADAPTERS)?.name, "deepseek");
});

test("pickAdapter selects Qwen for qwen URLs", () => {
  assertEqual(pickAdapter("https://chat.qwenlm.ai/api/chat", ADAPTERS)?.name, "qwen");
  assertEqual(pickAdapter("https://qwenlm.ai/api/chat/completions", ADAPTERS)?.name, "qwen");
  assertEqual(pickAdapter("https://chat.qwen.ai/api/chat", ADAPTERS)?.name, "qwen");
  assertEqual(pickAdapter("https://tongyi.aliyun.com/qianwen/api", ADAPTERS)?.name, "qwen");
});

test("pickAdapter returns undefined for unrelated URLs", () => {
  assertEqual(pickAdapter("https://api.openai.com/v1/chat/completions", ADAPTERS), undefined);
  assertEqual(pickAdapter("https://example.com/api", ADAPTERS), undefined);
});

test("fetch passthrough when no adapter matches", async () => {
  let originalCalled = false;
  let originalInput: RequestInfo | URL | undefined;
  let originalInit: RequestInit | undefined;

  const originalFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    originalCalled = true;
    originalInput = input;
    originalInit = init;
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  };

  const messages: AdapterMessage[] = [];
  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: (message) => messages.push(message),
    adapters: ADAPTERS,
  });

  try {
    const res = await window.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    assertTrue(originalCalled, "original fetch should be called for non-matching URL");
    assertEqual(originalInput, "https://api.openai.com/v1/chat/completions");
    assertTrue(originalInit?.body === JSON.stringify({ messages: [] }), "body unchanged");
    assertEqual(res.status, 200);
    assertEqual(messages.length, 0, "no reports for passthrough");
  } finally {
    uninstall();
  }
});

test("full request/response cycle with DeepSeek adapter", async () => {
  let originalUrl: string | undefined;
  let originalBody: string | undefined;

  const originalFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    originalUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    originalBody = await readRequestBody(init?.body ?? null);
    return new Response('{"choices":[{"message":{"role":"assistant","content":"ok"}}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const messages: AdapterMessage[] = [];
  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: (message) => messages.push(message),
    adapters: ADAPTERS,
  });

  try {
    const requestBody = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
    const res = await window.fetch("https://chat.deepseek.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });

    assertEqual(originalUrl, "https://chat.deepseek.com/api/chat");
    assertTrue(originalBody !== undefined && originalBody.includes("DeckAgent"), "tool system prompt injected into sent body");
    assertEqual(res.status, 200);

    assertEqual(messages.length, 2, "request and response reported");
    const requestReport = assertTruthy(messages[0], "request report");
    assertEqual(requestReport.type, "request");
    assertEqual(requestReport.source, "content-script");
    const reqPayload = requestReport.payload as InterceptedRequest;
    assertEqual(reqPayload.adapterType, "deepseek");
    assertTrue(reqPayload.body.includes("DeckAgent"), "reported request body includes injected prompt");

    const responseReport = assertTruthy(messages[1], "response report");
    assertEqual(responseReport.type, "response");
    const resPayload = responseReport.payload as InterceptedResponse;
    assertEqual(resPayload.status, 200);
    assertEqual(resPayload.requestId, reqPayload.id);
  } finally {
    uninstall();
  }
});

test("full request/response cycle with Qwen adapter", async () => {
  let originalUrl: string | undefined;

  const originalFetch = async (input: RequestInfo | URL): Promise<Response> => {
    originalUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new Response('{"output":{"text":"hello"}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const messages: AdapterMessage[] = [];
  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: (message) => messages.push(message),
    adapters: ADAPTERS,
  });

  try {
    await window.fetch("https://chat.qwenlm.ai/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    assertEqual(originalUrl, "https://chat.qwenlm.ai/api/chat");
    assertEqual(messages.length, 2);
    assertEqual(messages[0].type, "request");
    assertEqual((messages[0].payload as InterceptedRequest).adapterType, "qwen");
    assertEqual(messages[1].type, "response");
  } finally {
    uninstall();
  }
});

test("network error during intercept is propagated", async () => {
  const originalFetch = async (): Promise<Response> => {
    throw new Error("network failure");
  };

  const messages: AdapterMessage[] = [];
  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: (message) => messages.push(message),
    adapters: ADAPTERS,
  });

  try {
    let threw = false;
    try {
      await window.fetch("https://chat.deepseek.com/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      });
    } catch (err) {
      threw = true;
      assertTrue(err instanceof Error && err.message === "network failure");
    }
    assertTrue(threw, "network error should bubble up");
    assertEqual(messages.length, 1, "only request reported when response fails");
    assertEqual(messages[0].type, "request");
  } finally {
    uninstall();
  }
});

test("multiple simultaneous requests are handled independently", async () => {
  let callCount = 0;
  const originalFetch = async (input: RequestInfo | URL): Promise<Response> => {
    callCount++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new Response(JSON.stringify({ url, n: callCount }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const messages: AdapterMessage[] = [];
  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: (message) => messages.push(message),
    adapters: ADAPTERS,
  });

  try {
    const [r1, r2, r3] = await Promise.all([
      window.fetch("https://chat.deepseek.com/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "1" }] }),
      }),
      window.fetch("https://chat.qwenlm.ai/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "2" }] }),
      }),
      window.fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "3" }] }),
      }),
    ]);

    assertEqual(r1.status, 200);
    assertEqual(r2.status, 200);
    assertEqual(r3.status, 200);
    assertEqual(callCount, 3, "all three requests reached original fetch");

    const reports = messages.filter((m) => m.type === "request" || m.type === "response");
    assertEqual(reports.length, 4, "two requests and two responses from intercepted URLs");

    const adapterTypes = reports
      .filter((m) => m.type === "request")
      .map((m) => (m.payload as InterceptedRequest).adapterType)
      .sort();
    assertEqual(adapterTypes, ["deepseek", "qwen"]);
  } finally {
    uninstall();
  }
});

test("response body larger than limit is not read", async () => {
  const originalFetch = async (): Promise<Response> => {
    const body = "x".repeat(20 * 1024 * 1024);
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(body.length), "content-type": "text/plain" },
    });
  };

  const messages: AdapterMessage[] = [];
  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: (message) => messages.push(message),
    adapters: ADAPTERS,
  });

  try {
    await window.fetch("https://chat.deepseek.com/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const responseReport = messages.find((m) => m.type === "response");
    assertTrue(responseReport !== undefined, "response reported");
    assertEqual((responseReport.payload as InterceptedResponse).body, "[body-too-large]");
  } finally {
    uninstall();
  }
});

test("postMessage report wrapper includes correct source", async () => {
  const posted: { data: { source: string; message: AdapterMessage }; origin: string }[] = [];
  const originalPostMessage = (window as unknown as { postMessage: Function }).postMessage.bind(window);
  const stubPostMessage = (
    message: unknown,
    targetOrigin: string
  ) => {
    posted.push({ data: message as { source: string; message: AdapterMessage }, origin: targetOrigin });
  };
  (window as unknown as { postMessage: typeof stubPostMessage }).postMessage = stubPostMessage;

  const originalFetch = async (): Promise<Response> => {
    return new Response('{}', { status: 200, headers: { "content-type": "application/json" } });
  };

  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: createReportFn(),
    adapters: ADAPTERS,
  });

  try {
    await window.fetch("https://chat.deepseek.com/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    assertEqual(posted.length, 2);
    assertEqual(posted[0].data.source, "deckagent-v2-content-script");
    assertEqual(posted[0].origin, window.location.origin);
    assertEqual(posted[0].data.message.type, "request");
    assertEqual(posted[1].data.message.type, "response");
  } finally {
    uninstall();
    (window as unknown as { postMessage: typeof originalPostMessage }).postMessage = originalPostMessage;
  }
});

test("setupContentScript installs and returns uninstall function", () => {
  const originalFetch = window.fetch;
  const uninstall = setupContentScript();
  try {
    assertTrue(window.fetch !== originalFetch, "fetch should be monkey-patched");
    assertEqual(typeof uninstall, "function");
  } finally {
    uninstall();
  }
  assertTrue(window.fetch === originalFetch, "uninstall restores original fetch");
});

test("background script forwards content-script messages to daemon", async () => {
  // Dynamic import of background script inside a mocked chrome.runtime environment.
  const { connectListeners } = createMockChromeRuntime();
  const messageListeners: Array<
    (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => unknown
  > = [];

  (globalThis as unknown as Record<string, unknown>).chrome = {
    runtime: {
      onConnect: {
        addListener: (fn: (port: MockPort) => void) => connectListeners.push(fn),
      },
      onMessage: {
        addListener: (
          fn: (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => unknown
        ) => messageListeners.push(fn),
      },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: async () => [],
      sendMessage: async () => {},
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  } as Record<string, unknown>;

  let socketSendData: string | null = null;
  const wsInstances: Array<{
    handlers: Record<string, Array<(...args: unknown[]) => void>>;
    readyState: number;
  }> = [];
  (globalThis as unknown as Record<string, unknown>).WebSocket = class MockWebSocket {
    static OPEN = 1;
    readyState = 0;
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor() {
      wsInstances.push(this);
    }
    addEventListener(event: string, handler: (...args: unknown[]) => void) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(handler);
    }
    send(data: string) {
      socketSendData = data;
    }
    close() {}
  };

  const mod = await import("../src/entrypoints/background.js");
  const definition = mod.default as { main: () => void };
  assertTrue(typeof definition.main === "function", "background module exports a main function");
  definition.main();

  // Wait for init to create the WebSocket, then simulate open.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertTrue(wsInstances.length >= 1, "WebSocket was created");
  wsInstances[0].readyState = 1;
  for (const handler of wsInstances[0].handlers.open ?? []) {
    handler();
  }

  const port = createMockPort();
  for (const listener of connectListeners) {
    listener(port);
  }

  const adapterMessage: AdapterMessage = {
    id: "msg-1",
    type: "request",
    payload: { id: "req-1", adapterType: "deepseek", body: "{}", url: "", method: "POST", headers: {}, timestamp: Date.now() },
    timestamp: Date.now(),
    source: "content-script",
  };

  for (const listener of port.onMessage.listeners) {
    listener(adapterMessage);
  }

  assertTrue(socketSendData !== null, "background forwarded message to daemon via WebSocket");
  const sent = JSON.parse(socketSendData as string) as { jsonrpc: string; id: string; method: string; params: AdapterMessage };
  assertEqual(sent.jsonrpc, "2.0");
  assertEqual(sent.id, adapterMessage.id);
  assertEqual(sent.method, "intercepted_adapter_message");
  assertEqual(sent.params.source, "content-script");

  // Also verify runtime.onMessage adapter_message path
  socketSendData = null;
  for (const listener of messageListeners) {
    listener(
      { type: "adapter_message", message: { ...adapterMessage, id: "msg-2" } },
      { tab: { id: 1 } },
      () => {}
    );
  }
  assertTrue(socketSendData !== null, "onMessage adapter_message forwarded to daemon");
});

console.log("\nWaiting for async tests...");

setTimeout(() => {
  console.log(`\n${total - failed}/${total} passed`);
  if (failed > 0) process.exit(1);
}, 500);
