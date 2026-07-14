import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  extensionApi: "chrome",
  manifest: {
    name: "DeckAgent v2",
    version: "2.0.0",
    description: "Intercept web AI chat API calls and route them through your local DeckAgent daemon.",
    permissions: ["storage", "activeTab", "scripting", "background"],
    host_permissions: [
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
      "http://localhost/*",
      "https://localhost/*"
    ],
    action: {
      default_title: "DeckAgent v2",
      default_popup: "popup.html"
    },
    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png"
    }
  }
});
