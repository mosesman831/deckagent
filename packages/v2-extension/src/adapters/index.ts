import { DeepSeekAdapter } from "./deepseek.js";
import { qwenAdapter } from "./qwen.js";
import { kimiAdapter } from "./kimi.js";
import { zaiAdapter } from "./zai.js";

export { DeepSeekAdapter, qwenAdapter, kimiAdapter, zaiAdapter };
export const ADAPTERS = [DeepSeekAdapter, qwenAdapter, kimiAdapter, zaiAdapter] as const;
