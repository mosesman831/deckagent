import type {
  AdapterMessage,
  ChatAdapter,
  FetchMonkeyPatchContext,
  InterceptedRequest,
  InterceptedResponse,
  ToolCall
} from "../adapters/types.js";
import { ADAPTERS } from "../adapters/index.js";
import { appendToolResult, extractToolCallsFor } from "../adapters/tools.js";
import { MAIN_WORLD_SOURCE, BRIDGE_SOURCE, type BridgeOutbound } from "./messages.js";

const REQUEST_BODY_LIMIT = 10 * 1024 * 1024; // 10 MiB

type PendingToolResult = {
  requestId: string;
  adapterType: string;
  content: string;
};

declare global {
  interface Window {
    __deckagent_injected?: boolean;
    __deckagent_pending_results?: PendingToolResult[];
  }
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function readRequestBody(input: RequestInit["body"] | null): Promise<string> {
  if (input === undefined || input === null) return "";

  if (typeof input === "string") return input;

  if (input instanceof URLSearchParams) return input.toString();

  if (input instanceof FormData || input instanceof Blob) {
    return "[binary-body]";
  }

  if (ArrayBuffer.isView(input)) {
    return "[binary-body]";
  }

  return "[unsupported-body]";
}

export async function readResponseBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > REQUEST_BODY_LIMIT) {
    return "[body-too-large]";
  }

  try {
    const cloned = response.clone();
    return await cloned.text();
  } catch {
    return "[unreadable-body]";
  }
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export function pickAdapter(url: string, adapters: readonly ChatAdapter[]): ChatAdapter | undefined {
  return adapters.find((adapter) => adapter.match(url));
}

function drainPendingResults(adapterType: string): string[] {
  const pending = window.__deckagent_pending_results ?? [];
  if (pending.length === 0) return [];
  const matched = pending.filter((p) => p.adapterType === adapterType || !adapterType);
  const remaining = pending.filter((p) => !matched.includes(p));
  window.__deckagent_pending_results = remaining;
  return matched.map((p) => p.content);
}

function applyPendingResults(
  body: string,
  adapterType: string,
  appendFn: ((body: string, content: string) => string) | undefined
): string {
  if (!appendFn) return body;
  const results = drainPendingResults(adapterType);
  let next = body;
  for (const content of results) {
    next = appendFn(next, content);
  }
  return next;
}

export function installFetchMonkeyPatch(context: FetchMonkeyPatchContext): () => void {
  const { originalFetch, report, adapters } = context;

  async function buildInterceptedRequest(
    url: string,
    options: RequestInit = {}
  ): Promise<InterceptedRequest> {
    const bodyPromise = readRequestBody(options.body ?? null);
    const headers: Record<string, string> =
      options.headers === undefined
        ? {}
        : typeof options.headers === "string"
          ? { "raw-headers": options.headers }
          : headersToRecord(new Headers(options.headers));

    return bodyPromise.then((body) => ({
      id: generateId(),
      url,
      method: options.method?.toUpperCase() ?? "GET",
      headers,
      body,
      timestamp: Date.now(),
      adapterType: "unknown"
    }));
  }

  async function buildInterceptedResponse(
    request: InterceptedRequest,
    response: Response
  ): Promise<InterceptedResponse> {
    return {
      id: generateId(),
      requestId: request.id,
      status: response.status,
      statusText: response.statusText,
      headers: headersToRecord(response.headers),
      body: await readResponseBody(response),
      timestamp: Date.now()
    };
  }

  const patchedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    const adapter = pickAdapter(url, adapters);
    if (!adapter) {
      return originalFetch(input, init);
    }

    let request = await buildInterceptedRequest(url, init);
    request.adapterType = adapter.name;

    if (adapter.transformRequest) {
      request = await adapter.transformRequest(request);
    }

    // Fold any pending tool results into the outbound request body.
    request = {
      ...request,
      body: applyPendingResults(request.body, adapter.name, appendToolResult[adapter.name])
    };

    report({
      id: generateId(),
      type: "request",
      payload: request,
      timestamp: Date.now(),
      source: "content-script"
    });

    const fetchInit: RequestInit = {
      ...init,
      method: request.method,
      headers: request.headers
    };

    if (request.body && request.body !== "[binary-body]" && request.body !== "[unsupported-body]") {
      fetchInit.body = request.body;
    }

    const response = await originalFetch(request.url, fetchInit);
    let interceptedResponse = await buildInterceptedResponse(request, response);

    if (adapter.transformResponse) {
      interceptedResponse = await adapter.transformResponse(request, interceptedResponse);
    }

    const toolCalls: ToolCall[] | null = extractToolCallsFor(adapter.name, interceptedResponse.body);

    report({
      id: generateId(),
      type: "response",
      payload: {
        ...interceptedResponse,
        adapterType: adapter.name,
        toolCalls: toolCalls ?? undefined,
        requestBody: request.body
      },
      timestamp: Date.now(),
      source: "content-script"
    });

    return response;
  };

  window.fetch = patchedFetch;
  window.__deckagent_injected = true;

  return () => {
    window.fetch = originalFetch;
  };
}

export function createReportFn(): (message: AdapterMessage) => void {
  return (message) => {
    window.postMessage(
      {
        source: MAIN_WORLD_SOURCE,
        message
      },
      window.location.origin
    );
  };
}

function storePendingResult(result: PendingToolResult): void {
  if (!window.__deckagent_pending_results) {
    window.__deckagent_pending_results = [];
  }
  window.__deckagent_pending_results.push(result);
}

function showToolResultOverlay(results: BridgeOutbound & { type: "tool_result" }): void {
  try {
    const existing = document.getElementById("deckagent-tool-overlay");
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.id = "deckagent-tool-overlay";
    panel.setAttribute(
      "style",
      [
        "position:fixed",
        "bottom:16px",
        "right:16px",
        "z-index:2147483646",
        "max-width:420px",
        "max-height:40vh",
        "overflow:auto",
        "background:#0f172a",
        "color:#e2e8f0",
        "border:1px solid #38bdf8",
        "border-radius:8px",
        "padding:12px 14px",
        "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
        "box-shadow:0 8px 24px rgba(0,0,0,.35)"
      ].join(";")
    );

    const title = document.createElement("div");
    title.textContent = "DeckAgent tool results";
    title.setAttribute("style", "font-weight:600;margin-bottom:8px;color:#38bdf8");
    panel.appendChild(title);

    for (const item of results.results) {
      const row = document.createElement("div");
      row.setAttribute("style", "margin-bottom:8px;white-space:pre-wrap;word-break:break-word");
      const status = item.ok ? "ok" : "error";
      const body = item.ok ? (item.content ?? "") : (item.error ?? "unknown error");
      row.textContent = `${item.name} [${status}]\n${body.slice(0, 2000)}`;
      panel.appendChild(row);
    }

    const hint = document.createElement("div");
    hint.textContent = "Results will be appended to the next chat request.";
    hint.setAttribute("style", "opacity:.7;margin-top:4px");
    panel.appendChild(hint);

    const close = document.createElement("button");
    close.textContent = "Dismiss";
    close.setAttribute(
      "style",
      "margin-top:8px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:4px 8px;cursor:pointer"
    );
    close.addEventListener("click", () => panel.remove());
    panel.appendChild(close);

    document.documentElement.appendChild(panel);
    setTimeout(() => {
      if (panel.isConnected) panel.remove();
    }, 60_000);
  } catch {
    // DOM may be unavailable in some test environments.
  }
}

export function listenForBridgeResults(): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as BridgeOutbound | undefined;
    if (!data || data.source !== BRIDGE_SOURCE) return;

    if (data.type === "tool_result") {
      for (const item of data.results) {
        const content = item.ok
          ? item.content ?? ""
          : `Error executing ${item.name}: ${item.error ?? "unknown"}`;
        storePendingResult({
          requestId: data.requestId,
          adapterType: data.adapterType,
          content: `${item.name}: ${content}`
        });
      }
      showToolResultOverlay(data);
    }
  };

  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

export function setupMainWorld(): () => void {
  const report = createReportFn();
  const originalFetch = window.fetch;
  const uninstallPatch = installFetchMonkeyPatch({
    originalFetch,
    report,
    adapters: ADAPTERS
  });
  const uninstallBridge = listenForBridgeResults();

  return () => {
    uninstallPatch();
    uninstallBridge();
  };
}

/** @deprecated Use setupMainWorld — kept for existing tests. */
export function setupContentScript(): () => void {
  return setupMainWorld();
}
