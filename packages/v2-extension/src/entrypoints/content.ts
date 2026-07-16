/**
 * Isolated-world content script.
 * Forwards MAIN-world postMessage traffic to the background service worker
 * via chrome.runtime, and relays tool results back to the page.
 */
import { defineContentScript } from "wxt/sandbox";
import {
  BRIDGE_SOURCE,
  isBridgeInbound,
  type RuntimeMessage
} from "../lib/messages.js";

function setupIsolatedBridge(): () => void {
  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!isBridgeInbound(event.data)) return;

    const payload: RuntimeMessage = {
      type: "adapter_message",
      message: event.data.message
    };

    try {
      void chrome.runtime.sendMessage(payload);
    } catch {
      // Extension context invalidated (reload) — ignore.
    }
  };

  const onRuntimeMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean | void => {
    const msg = message as { type?: string; source?: string } & Record<string, unknown>;

    if (msg?.type === "tool_result" || msg?.source === BRIDGE_SOURCE) {
      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          ...msg
        },
        window.location.origin
      );
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === "ping") {
      sendResponse({ ok: true, world: "isolated" });
      return false;
    }

    return undefined;
  };

  window.addEventListener("message", onWindowMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  return () => {
    window.removeEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  };
}

export default defineContentScript({
  // Matches must be inline literals — WXT forbids imported option values.
  matches: [
    "https://chat.deepseek.com/*",
    "https://www.deepseek.com/*",
    "https://deepseek.com/*",
    "https://chat.qwenlm.ai/*",
    "https://qwenlm.ai/*",
    "https://chat.qwen.ai/*",
    "https://qwen.ai/*",
    "https://tongyi.aliyun.com/*",
    "https://kimi.com/*",
    "https://*.kimi.com/*",
    "https://moonshot.ai/*",
    "https://*.moonshot.ai/*",
    "https://z.ai/*",
    "https://*.z.ai/*",
    "https://api.z.ai/*",
    "https://chatglm.cn/*",
    "https://*.chatglm.cn/*",
    "http://localhost/*",
    "https://localhost/*"
  ],
  runAt: "document_start",
  // Default ISOLATED world — has chrome.runtime access.
  main() {
    setupIsolatedBridge();
  }
});
