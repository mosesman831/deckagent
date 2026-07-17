import {
  BrowserNavigateArgsSchema,
  BrowserScreenshotArgsSchema,
  BrowserClickArgsSchema,
  BrowserEvaluateArgsSchema,
  type BrowserNavigateArgs,
  type BrowserScreenshotArgs,
  type BrowserClickArgs,
  type BrowserEvaluateArgs,
  type ToolResponse,
} from "../schemas.js";

const BROWSER_DISABLED = "Browser tools require --enable-browser flag at daemon level";

export async function browser_navigate(args: BrowserNavigateArgs): Promise<ToolResponse> {
  BrowserNavigateArgsSchema.parse(args);
  throw new Error(BROWSER_DISABLED);
}

export async function browser_screenshot(args: BrowserScreenshotArgs): Promise<ToolResponse> {
  BrowserScreenshotArgsSchema.parse(args);
  throw new Error(BROWSER_DISABLED);
}

export async function browser_click(args: BrowserClickArgs): Promise<ToolResponse> {
  BrowserClickArgsSchema.parse(args);
  throw new Error(BROWSER_DISABLED);
}

export async function browser_evaluate(args: BrowserEvaluateArgs): Promise<ToolResponse> {
  BrowserEvaluateArgsSchema.parse(args);
  throw new Error(BROWSER_DISABLED);
}
