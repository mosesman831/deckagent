/** Shared content-script / host permission match patterns. */
export const CONTENT_SCRIPT_MATCHES = [
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
] as const;
