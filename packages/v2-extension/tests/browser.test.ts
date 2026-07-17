import CDP from "chrome-remote-interface";

const TEST_PAGE = "http://localhost:8765/browser-test.html";
const EXTENSION_ID_QUERY_TIMEOUT = 5000;
const PAGE_READY_TIMEOUT = 10000;

interface TestResult {
  injected: boolean;
  messages: Array<{
    id: string;
    type: "request" | "response" | "event" | "error";
    payload: unknown;
    timestamp: number;
    source: string;
  }>;
  fetches: Array<{
    adapter: string;
    url: string;
    status?: number;
    ok?: boolean;
    error?: string;
  }>;
  complete?: boolean;
}

async function getExtensionId(client: CDP.Client): Promise<string> {
  const { Target } = client;
  const targets = (await Target.getTargets()).targetInfos;
  const extTarget = targets.find(
    (t: { type: string; url?: string }) =>
      t.type === "service_worker" && t.url?.startsWith("chrome-extension://")
  );
  if (!extTarget) {
    throw new Error("Extension service worker target not found");
  }
  const m = extTarget.url.match(/chrome-extension:\/\/([^/]+)/);
  if (!m) {
    throw new Error("Could not parse extension ID from service worker URL");
  }
  return m[1];
}

async function getServiceWorkerConsoleLogs(client: CDP.Client): Promise<string[]> {
  const logs: string[] = [];
  client.Runtime.consoleAPICalled(({ type, args }: { type: string; args: Array<{ value?: unknown }> }) => {
    const text = args.map((a) => (typeof a.value === "string" ? a.value : JSON.stringify(a.value))).join(" ");
    logs.push(`[${type}] ${text}`);
  });
  return logs;
}

async function main(): Promise<void> {
  const client = await CDP({ port: 9222 });
  const { Page, Runtime } = client;

  try {
    await Page.enable();
    await Runtime.enable();

    const swLogsPromise = getServiceWorkerConsoleLogs(client);

    console.log("Navigating to test page...");
    await Page.navigate({ url: TEST_PAGE });
    await Page.loadEventFired();

    // Wait for content script injection and simulation to finish.
    const deadline = Date.now() + PAGE_READY_TIMEOUT;
    let result: TestResult | null = null;
    while (Date.now() < deadline) {
      const { result: rawResult } = await Runtime.evaluate({
        expression: "window.__deckagent_test_results",
        returnByValue: true,
        awaitPromise: false
      });
      result = (rawResult?.value as TestResult | undefined) ?? null;
      if (result?.complete) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!result) {
      throw new Error("Test results object not found on page");
    }

    // Check content script injection marker.
    const { result: injectedResult } = await Runtime.evaluate({
      expression: "typeof window.__deckagent_injected !== 'undefined'",
      returnByValue: true,
      awaitPromise: false
    });
    const injected = injectedResult?.value === true;

    // Gather console messages from the page.
    const { result: consoleResult } = await Runtime.evaluate({
      expression: "window.__deckagent_test_results.messages.map(m => m.type + ':' + (m.payload as any)?.adapterType).join('\\n')",
      returnByValue: true,
      awaitPromise: false
    });
    console.log("Intercepted message types:");
    console.log(consoleResult?.value || "(none)");

    // Validate results.
    const errors: string[] = [];

    if (!injected) {
      errors.push("Content script injection marker (window.__deckagent_injected) not found");
    }

    const adapterNames = ["deepseek", "qwen", "kimi", "zai"];
    const interceptedAdapters = new Set(
      result.messages
        .filter((m) => m.type === "request")
        .map((m) => (m.payload as { adapterType?: string })?.adapterType)
        .filter(Boolean)
    );

    for (const name of adapterNames) {
      if (!interceptedAdapters.has(name)) {
        errors.push(`Adapter ${name} request was not intercepted`);
      }
    }

    if (result.fetches.length !== adapterNames.length) {
      errors.push(`Expected ${adapterNames.length} fetch simulations, got ${result.fetches.length}`);
    }

    const fetchErrors = result.fetches.filter((f) => f.error).map((f) => `${f.adapter}: ${f.error}`);
    if (fetchErrors.length > 0) {
      errors.push(`Fetch errors: ${fetchErrors.join("; ")}`);
    }

    // Extension service worker check.
    let extensionId: string | null = null;
    try {
      extensionId = await getExtensionId(client);
      console.log(`Extension service worker active: ${extensionId}`);
    } catch (err) {
      errors.push(`Service worker not found: ${err instanceof Error ? err.message : String(err)}`);
    }

    const swLogs = await swLogsPromise;
    const swErrors = swLogs.filter((l) => l.startsWith("[error]") || l.includes("error"));
    if (swErrors.length > 0) {
      errors.push(`Service worker errors: ${swErrors.join("; ")}`);
    }

    if (errors.length > 0) {
      console.error("Browser integration test failed:");
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    console.log("Browser integration test passed.");
    console.log(`  Content script injected: ${injected}`);
    console.log(`  Intercepted adapters: ${Array.from(interceptedAdapters).join(", ")}`);
    console.log(`  Service worker extension ID: ${extensionId}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Unexpected error running browser test:", err);
  process.exit(1);
});
