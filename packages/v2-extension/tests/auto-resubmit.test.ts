/**
 * Auto-resubmit integration tests — kept separate from content-script.test.ts
 * so they do not race other installFetchMonkeyPatch suites on shared window.fetch.
 */
import "./dom-test-bootstrap.js";
import { ADAPTERS } from "../src/adapters/index.js";
import { installFetchMonkeyPatch, tryAutoResubmit } from "../src/lib/fetch-patch.js";
import { BRIDGE_SOURCE } from "../src/lib/messages.js";
import { createAutoContinueState } from "../src/lib/auto-continue.js";

let failed = 0;

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

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("Auto-resubmit integration tests");

await run("tryAutoResubmit appends tool results and re-fetches", async () => {
  const bodies: string[] = [];
  const originalFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response('{"choices":[{"message":{"role":"assistant","content":"done"}}]}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: () => {},
    adapters: ADAPTERS
  });

  try {
    window.__deckagent_pending_results = [];
    window.__deckagent_auto_continue = createAutoContinueState();
    window.__deckagent_last_request = null;

    await window.fetch("https://chat.deepseek.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "list files" }] })
    });
    assertTrue(window.__deckagent_last_request != null, "last request cached");
    assertEqual(bodies.length, 1);

    const outcome = await tryAutoResubmit({
      source: BRIDGE_SOURCE,
      type: "tool_result",
      requestId: "req-1",
      adapterType: "deepseek",
      results: [{ name: "list_directory", args: {}, ok: true, content: "a.txt\nb.txt" }]
    });

    assertEqual(outcome, "resubmitted");
    assertEqual(bodies.length, 2, "auto-continue should issue a second fetch");
    assertTrue(bodies[1].includes("TOOL_RESULT"), "resubmit body includes tool result");
    assertTrue(bodies[1].includes("list_directory"), "resubmit body includes tool name");
    assertEqual(window.__deckagent_pending_results ?? [], []);
  } finally {
    uninstall();
    window.__deckagent_pending_results = [];
    window.__deckagent_last_request = null;
    window.__deckagent_auto_continue = createAutoContinueState();
  }
});

await run("tryAutoResubmit stops and queues on tool error", async () => {
  const originalFetch = async (): Promise<Response> =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: () => {},
    adapters: ADAPTERS
  });

  try {
    window.__deckagent_pending_results = [];
    window.__deckagent_auto_continue = createAutoContinueState();
    await window.fetch("https://chat.deepseek.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    });

    const outcome = await tryAutoResubmit({
      source: BRIDGE_SOURCE,
      type: "tool_result",
      requestId: "req-err",
      adapterType: "deepseek",
      results: [{ name: "read_file", args: {}, ok: false, error: "denied" }]
    });

    assertEqual(outcome, "stopped");
    assertTrue((window.__deckagent_pending_results ?? []).length >= 1);
  } finally {
    uninstall();
    window.__deckagent_pending_results = [];
    window.__deckagent_last_request = null;
    window.__deckagent_auto_continue = createAutoContinueState();
  }
});

await run("tryAutoResubmit queues after max auto-continues", async () => {
  let fetchCount = 0;
  const originalFetch = async (): Promise<Response> => {
    fetchCount++;
    return new Response('{"choices":[{"message":{"content":"ok"}}]}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report: () => {},
    adapters: ADAPTERS
  });

  try {
    window.__deckagent_pending_results = [];
    window.__deckagent_auto_continue = createAutoContinueState();
    await window.fetch("https://chat.deepseek.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    });
    const baseline = fetchCount;

    window.__deckagent_auto_continue = { count: 3, lastAt: Date.now() };

    const outcome = await tryAutoResubmit({
      source: BRIDGE_SOURCE,
      type: "tool_result",
      requestId: "req-cap",
      adapterType: "deepseek",
      results: [{ name: "read_file", args: {}, ok: true, content: "x" }]
    });

    assertEqual(outcome, "queued");
    assertEqual(fetchCount, baseline, "capped continue must not fetch again");
    assertTrue((window.__deckagent_pending_results ?? []).length >= 1);
  } finally {
    uninstall();
    window.__deckagent_pending_results = [];
    window.__deckagent_last_request = null;
    window.__deckagent_auto_continue = createAutoContinueState();
  }
});

console.log(`\n${3 - failed}/3 passed`);
process.exit(failed > 0 ? 1 : 0);
