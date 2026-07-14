import { defineBackground } from "wxt/sandbox";
import type { AdapterMessage, DaemonMessage, ExtensionConfig } from "../adapters/types.js";
import { DEFAULT_CONFIG } from "../adapters/types.js";
import { ADAPTERS } from "../adapters/index.js";

interface PortLike {
  postMessage(message: unknown): void;
}

function getDaemonUrl(config: ExtensionConfig): string {
  return `ws://${config.daemonHost}:${config.daemonPort}/tunnel`;
}

function createBufferedSocket(url: string): {
  socket: WebSocket;
  send: (message: DaemonMessage) => void;
  flush: () => void;
} {
  const buffer: DaemonMessage[] = [];
  let ready = false;

  const socket = new WebSocket(url);
  socket.binaryType = "blob";

  const send = (message: DaemonMessage) => {
    if (ready && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message) + "\n");
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
  return DEFAULT_CONFIG;
}

export default defineBackground(() => {
  let config = DEFAULT_CONFIG;
  let activeSocket: ReturnType<typeof createBufferedSocket> | null = null;
  const ports = new Set<PortLike>();

  async function injectContentScript(tabId: number) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["/content-scripts/content-script.js"]
      });
    } catch {
      // Already injected or unsupported URL.
    }
  }

  async function init() {
    config = await loadConfig();
    if (!config.enabled) return;

    activeSocket = createBufferedSocket(getDaemonUrl(config));

    activeSocket.socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as DaemonMessage;
          broadcast({
            id: `${Date.now()}`,
            type: "event",
            payload: message,
            timestamp: Date.now(),
            source: "daemon"
          });
        } catch {
          // Ignore malformed daemon lines.
        }
      }
    });

    activeSocket.socket.addEventListener("close", () => {
      activeSocket = null;
      setTimeout(init, 5000);
    });

    activeSocket.socket.addEventListener("error", () => {
      activeSocket?.socket.close();
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === "complete" && tab.url) {
        void injectContentScript(tabId);
      }
    });

    const tabs = await chrome.tabs.query({ url: CONTENT_SCRIPT_MATCHES });
    for (const tab of tabs) {
      if (tab.id) void injectContentScript(tab.id);
    }
  }

  const CONTENT_SCRIPT_MATCHES = ADAPTERS.flatMap((a) => {
    const host = a.hostPattern.source.replace(/^\^?/, "").replace(/\$?$/, "");
    return [`https://*${host}/*`, `https://${host}/*`];
  });

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

  function handleContentScriptMessage(message: unknown): void {
    const adapterMessage = message as AdapterMessage;
    if (adapterMessage.source === "content-script") {
      forwardToDaemon(adapterMessage);
    }
  }

  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    ports.add(port as unknown as PortLike);
    port.onMessage.addListener(handleContentScriptMessage);
    port.onDisconnect.addListener(() => {
      ports.delete(port as unknown as PortLike);
    });
  });

  chrome.runtime.onMessage.addListener(handleContentScriptMessage);

  void init();
});
