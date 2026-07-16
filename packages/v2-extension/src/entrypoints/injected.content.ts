/**
 * MAIN-world content script.
 * Patches window.fetch so page-originated API calls are visible,
 * then reports via window.postMessage to the isolated bridge.
 */
import { defineContentScript } from "wxt/sandbox";
import { setupMainWorld } from "../lib/fetch-patch.js";

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
  world: "MAIN",
  main() {
    setupMainWorld();
  }
});
