import { DeepSeekAdapter } from "./deepseek.js";
import { qwenAdapter } from "./qwen.js";
import { kimiAdapter } from "./kimi.js";

export { DeepSeekAdapter, qwenAdapter, kimiAdapter };
export const ADAPTERS = [DeepSeekAdapter, qwenAdapter, kimiAdapter] as const;
