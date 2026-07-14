import { defineContentScript } from "wxt/sandbox";
import type {
  AdapterMessage,
  ChatAdapter,
  FetchMonkeyPatchContext,
  InterceptedRequest,
  InterceptedResponse
} from "../adapters/types.js";
import { ADAPTERS } from "../adapters/index.js";

const REQUEST_BODY_LIMIT = 10 * 1024 * 1024; // 10 MiB

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

    report({
      id: generateId(),
      type: "response",
      payload: interceptedResponse,
      timestamp: Date.now(),
      source: "content-script"
    });

    return response;
  };

  window.fetch = patchedFetch;
  (window as typeof window & { __deckagent_injected?: boolean }).__deckagent_injected = true;

  return () => {
    window.fetch = originalFetch;
  };
}

export function createReportFn(): (message: AdapterMessage) => void {
  return (message) => {
    window.postMessage(
      {
        source: "deckagent-v2-content-script",
        message
      },
      window.location.origin
    );
  };
}

export function setupContentScript(): () => void {
  const report = createReportFn();
  const originalFetch = window.fetch;
  const uninstall = installFetchMonkeyPatch({
    originalFetch,
    report,
    adapters: ADAPTERS
  });

  return uninstall;
}

export default defineContentScript({
  matches: [
    "https://chat.deepseek.com/*",
    "https://www.deepseek.com/*",
    "https://chat.qwenlm.ai/*",
    "https://qwenlm.ai/*",
    "https://kimi.com/*",
    "https://*.kimi.com/*",
    "https://moonshot.ai/*",
    "https://*.moonshot.ai/*",
    "https://*.z.ai/*",
    "https://api.z.ai/*",
    "https://chatglm.cn/*",
    "https://*.chatglm.cn/*",
    "http://localhost:*/*",
    "https://localhost:*/*"
  ],
  main: setupContentScript
});
