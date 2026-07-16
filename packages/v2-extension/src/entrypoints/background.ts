import { defineBackground } from "wxt/sandbox";
import type {
  AdapterMessage,
  DaemonMessage,
  ExtensionConfig,
  InterceptedRequest,
  InterceptedResponse,
  ToolCall
} from "../adapters/types.js";
import { DEFAULT_CONFIG } from "../adapters/types.js";
import { ADAPTERS } from "../adapters/index.js";
import { extractToolCallsFor } from "../adapters/tools.js";
import { CONTENT_SCRIPT_MATCHES } from "../lib/matches.js";
import type { RuntimeMessage, StatusResponse } from "../lib/messages.js";
import { BRIDGE_SOURCE } from "../lib/messages.js";

interface PortLike {
  postMessage(message: unknown): void;
}

type PendingRequest = {
  adapterType: string;
  body: string;
  tabId?: number;
};

type DaemonToolResponse =
  | { type: "tool_result"; id: string; result: { content: unknown; isError?: boolean } }
  | { type: "tool_error"; id: string; error: { code?: number; message: string } };

function getDaemonUrl(config: ExtensionConfig): string {
  return `ws://${config.daemonHost}:${config.daemonPort}/tunnel`;
}

function createBufferedSocket(url: string): {
  socket: WebSocket;
  send: (message: Record<string, unknown>) => void;
  flush: () => void;
} {
  const buffer: Record<string, unknown>[] = [];
  let ready = false;

  const socket = new WebSocket(url);
  socket.binaryType = "blob";

  const send = (message: Record<string, unknown>) => {
    const line = JSON.stringify(message) + "\n";
    if (ready && socket.readyState === WebSocket.OPEN) {
      socket.send(line);
    } else {
      buffer.push(message);
    }
  };

  const flush = () => {
    while (buffer.length > 0 && socket.readyState === WebSocket.OPEN) {
      const message = buffer.shift();
      if (message) socket.send(JSON.stringify(message) + "\n");
    }
  };

  socket.addEventListener("open", () => {
    ready = true;
    flush();
  });

  return { socket, send, flush };
}

async function loadConfig(): Promise<ExtensionConfig> {
  try {
    const stored = await chrome.storage.local.get(["config"]);
    if (stored.config && typeof stored.config === "object") {
      return { ...DEFAULT_CONFIG, ...(stored.config as ExtensionConfig) };
    }
  } catch {
    // storage unavailable in tests
  }
  return { ...DEFAULT_CONFIG };
}

async function saveConfig(config: ExtensionConfig): Promise<void> {
  try {
    await chrome.storage.local.set({ config });
  } catch {
    // ignore
  }
}

function formatToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in (part as object)) {
          return String((part as { text: unknown }).text);
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export default defineBackground(() => {
  let config = { ...DEFAULT_CONFIG };
  let activeSocket: ReturnType<typeof createBufferedSocket> | null = null;
  let daemonConnected = false;
  const ports = new Set<PortLike>();
  const pendingRequests = new Map<string, PendingRequest>();
  const pendingToolWaiters = new Map<
    string,
    {
      resolve: (value: DaemonToolResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function broadcast(message: AdapterMessage): void {
    for (const port of Array.from(ports)) {
      try {
        port.postMessage(message);
      } catch {
        ports.delete(port);
      }
    }
  }

  function forwardToDaemon(message: AdapterMessage): void {
    if (!activeSocket) return;
    activeSocket.send({
      jsonrpc: "2.0",
      id: message.id,
      method: "intercepted_adapter_message",
      params: message
    });
  }

  function executeToolOnDaemon(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<DaemonToolResponse> {
    return new Promise((resolve, reject) => {
      if (!activeSocket || !daemonConnected) {
        reject(new Error("Daemon is not connected"));
        return;
      }

      const timer = setTimeout(() => {
        pendingToolWaiters.delete(id);
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pendingToolWaiters.set(id, { resolve, reject, timer });

      activeSocket.send({
        type: "execute_tool",
        id,
        tool,
        args
      });
    });
  }

  async function deliverToolResultsToTab(
    tabId: number | undefined,
    payload: {
      requestId: string;
      adapterType: string;
      results: Array<{
        name: string;
        args: Record<string, unknown>;
        ok: boolean;
        content?: string;
        error?: string;
      }>;
    }
  ): Promise<void> {
    const message = {
      source: BRIDGE_SOURCE,
      type: "tool_result" as const,
      ...payload
    };

    if (tabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
        return;
      } catch {
        // Fall through to broadcast
      }
    }

    // Fallback: try all tabs matching our hosts
    try {
      const tabs = await chrome.tabs.query({ url: [...CONTENT_SCRIPT_MATCHES] });
      await Promise.all(
        tabs.map(async (tab) => {
          if (!tab.id) return;
          try {
            await chrome.tabs.sendMessage(tab.id, message);
          } catch {
            // tab may not have content script
          }
        })
      );
    } catch {
      // ignore
    }
  }

  async function handleToolCalls(opts: {
    requestId: string;
    adapterType: string;
    toolCalls: ToolCall[];
    tabId?: number;
  }): Promise<void> {
    const results: Array<{
      name: string;
      args: Record<string, unknown>;
      ok: boolean;
      content?: string;
      error?: string;
    }> = [];

    for (const call of opts.toolCalls) {
      const execId = `${opts.requestId}-${call.name}-${Date.now()}`;
      try {
        const response = await executeToolOnDaemon(execId, call.name, call.args);
        if (response.type === "tool_result") {
          const isError = Boolean(response.result.isError);
          results.push({
            name: call.name,
            args: call.args,
            ok: !isError,
            content: formatToolContent(response.result.content),
            error: isError ? formatToolContent(response.result.content) : undefined
          });
        } else {
          results.push({
            name: call.name,
            args: call.args,
            ok: false,
            error: response.error.message
          });
        }
      } catch (err) {
        results.push({
          name: call.name,
          args: call.args,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    await deliverToolResultsToTab(opts.tabId, {
      requestId: opts.requestId,
      adapterType: opts.adapterType,
      results
    });

    broadcast({
      id: `${opts.requestId}-tools`,
      type: "event",
      payload: { toolResults: results, requestId: opts.requestId },
      timestamp: Date.now(),
      source: "background"
    });
  }

  function handleAdapterMessage(
    adapterMessage: AdapterMessage,
    tabId?: number
  ): void {
    if (adapterMessage.source !== "content-script") return;

    forwardToDaemon(adapterMessage);

    if (adapterMessage.type === "request") {
      const req = adapterMessage.payload as InterceptedRequest;
      if (req?.id) {
        pendingRequests.set(req.id, {
          adapterType: req.adapterType,
          body: req.body,
          tabId
        });
      }
      return;
    }

    if (adapterMessage.type === "response") {
      const res = adapterMessage.payload as InterceptedResponse;
      const pending = res.requestId ? pendingRequests.get(res.requestId) : undefined;
      const adapterType = res.adapterType ?? pending?.adapterType ?? "unknown";
      const resolvedTabId = tabId ?? pending?.tabId;

      let toolCalls = res.toolCalls ?? null;
      if (!toolCalls || toolCalls.length === 0) {
        toolCalls = extractToolCallsFor(adapterType, res.body);
      }

      if (toolCalls && toolCalls.length > 0) {
        void handleToolCalls({
          requestId: res.requestId,
          adapterType,
          toolCalls,
          tabId: resolvedTabId
        });
      }

      if (res.requestId) pendingRequests.delete(res.requestId);
    }
  }

  function handleDaemonLine(line: string): void {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;

      if (message.type === "local_ready") {
        daemonConnected = true;
        return;
      }

      if (message.type === "tool_result" || message.type === "tool_error") {
        const id = String(message.id ?? "");
        const waiter = pendingToolWaiters.get(id);
        if (waiter) {
          clearTimeout(waiter.timer);
          pendingToolWaiters.delete(id);
          waiter.resolve(message as DaemonToolResponse);
        }
      }

      broadcast({
        id: `${Date.now()}`,
        type: "event",
        payload: message as unknown as DaemonMessage,
        timestamp: Date.now(),
        source: "daemon"
      });
    } catch {
      // Ignore malformed daemon lines.
    }
  }

  async function connectDaemon(): Promise<void> {
    if (!config.enabled) return;

    activeSocket = createBufferedSocket(getDaemonUrl(config));

    activeSocket.socket.addEventListener("open", () => {
      daemonConnected = true;
    });

    activeSocket.socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      // Also handle Blob in some environments
      if (!text && event.data instanceof Blob) {
        void event.data.text().then((t) => {
          for (const line of t.split("\n")) {
            if (line.trim()) handleDaemonLine(line);
          }
        });
        return;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        handleDaemonLine(line);
      }
    });

    activeSocket.socket.addEventListener("close", () => {
      daemonConnected = false;
      activeSocket = null;
      for (const [id, waiter] of pendingToolWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Daemon connection closed"));
        pendingToolWaiters.delete(id);
      }
      setTimeout(() => {
        void connectDaemon();
      }, 5000);
    });

    activeSocket.socket.addEventListener("error", () => {
      daemonConnected = false;
      activeSocket?.socket.close();
    });
  }

  async function init() {
    config = await loadConfig();
    await connectDaemon();
  }

  function getStatus(): StatusResponse {
    return {
      enabled: config.enabled,
      daemonConnected,
      daemonUrl: getDaemonUrl(config),
      adapters: ADAPTERS.map((a) => ({
        name: a.name,
        enabled: config.adapters[a.name] !== false
      }))
    };
  }

  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    ports.add(port as unknown as PortLike);
    port.onMessage.addListener((message: unknown) => {
      const adapterMessage = message as AdapterMessage;
      handleAdapterMessage(adapterMessage);
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port as unknown as PortLike);
    });
  });

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      const msg = message as RuntimeMessage;

      if (!msg || typeof msg !== "object" || !("type" in msg)) {
        // Legacy: raw AdapterMessage
        if ((message as AdapterMessage)?.source === "content-script") {
          handleAdapterMessage(message as AdapterMessage, sender.tab?.id);
          sendResponse({ ok: true });
          return false;
        }
        return undefined;
      }

      if (msg.type === "adapter_message") {
        handleAdapterMessage(msg.message, sender.tab?.id);
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === "get_status") {
        sendResponse(getStatus());
        return false;
      }

      if (msg.type === "set_enabled") {
        config = { ...config, enabled: msg.enabled };
        void saveConfig(config).then(() => {
          if (msg.enabled && !activeSocket) {
            void connectDaemon();
          } else if (!msg.enabled && activeSocket) {
            activeSocket.socket.close();
            activeSocket = null;
            daemonConnected = false;
          }
          sendResponse(getStatus());
        });
        return true; // async
      }

      if (msg.type === "ping") {
        sendResponse({ ok: true, daemonConnected });
        return false;
      }

      return undefined;
    }
  );

  void init();
});
