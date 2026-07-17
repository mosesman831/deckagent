import type { ToolCall } from "./types.js";
import {
  extractToolCalls as deepseekExtract,
  appendToolResult as deepseekAppend
} from "./deepseek.js";
import {
  extractToolCalls as qwenExtract,
  appendToolResult as qwenAppend
} from "./qwen.js";
import {
  extractToolCalls as kimiExtract,
  appendToolResult as kimiAppend
} from "./kimi.js";
import {
  extractToolCalls as zaiExtract,
  appendToolResult as zaiAppend
} from "./zai.js";

export type ToolExtractor = (body: string) => ToolCall[] | null;
export type ToolAppender = (body: string, content: string) => string;

export const extractToolCalls: Record<string, ToolExtractor> = {
  deepseek: deepseekExtract,
  qwen: qwenExtract,
  kimi: kimiExtract,
  zai: zaiExtract
};

export const appendToolResult: Record<string, ToolAppender> = {
  deepseek: deepseekAppend,
  qwen: qwenAppend,
  kimi: kimiAppend,
  zai: zaiAppend
};

export function extractToolCallsFor(adapterType: string, body: string): ToolCall[] | null {
  const fn = extractToolCalls[adapterType];
  if (!fn) {
    // Fallback: scan raw body for TOOL markers using deepseek extractor.
    return deepseekExtract(body);
  }
  return fn(body);
}

export function appendToolResultFor(adapterType: string, body: string, content: string): string {
  const fn = appendToolResult[adapterType] ?? deepseekAppend;
  return fn(body, content);
}
