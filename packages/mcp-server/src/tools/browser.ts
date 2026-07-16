import type { Browser, BrowserContext, Page, Route } from "playwright";
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

const PLAYWRIGHT_INSTALL_HINT =
  "Playwright Chromium is not installed. Run: npx playwright install chromium";

const BROWSER_DISABLED =
  "Browser tools are disabled. Enable them via daemon policy (allow_browser) or setBrowserEnabled(true).";

let browserEnabled = false;
let browserInstance: Browser | null = null;
let browserContext: BrowserContext | null = null;
let pageInstance: Page | null = null;
let launchedHeadless: boolean | null = null;

export interface BrowserHostPolicy {
  allow: readonly string[];
  deny: readonly string[];
  onNavigate?: (url: string, allowed: boolean, reason?: string) => void;
}

export interface BrowserHostDecision {
  allowed: boolean;
  host?: string;
  reason?: string;
}

let browserHostPolicy: BrowserHostPolicy | null = null;

export function setBrowserEnabled(enabled: boolean): void {
  browserEnabled = enabled;
}

export function setBrowserHostPolicy(policy: BrowserHostPolicy | null): void {
  browserHostPolicy = policy
    ? {
        allow: [...policy.allow],
        deny: [...policy.deny],
        onNavigate: policy.onNavigate,
      }
    : null;
}

export function browserHostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedHost || !normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return (
      normalizedHost.endsWith(suffix) ||
      normalizedHost === normalizedPattern.slice(2)
    );
  }
  return normalizedHost === normalizedPattern;
}

export function evaluateBrowserHostPolicy(
  urlString: string,
  policy: BrowserHostPolicy | null = browserHostPolicy,
): BrowserHostDecision {
  if (!policy) return { allowed: true };

  let host: string;
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { allowed: true };
    }
    host = url.hostname.toLowerCase();
  } catch {
    return {
      allowed: false,
      reason: `Invalid browser URL '${urlString}'`,
    };
  }

  for (const pattern of policy.deny) {
    if (browserHostMatches(host, pattern)) {
      return {
        allowed: false,
        host,
        reason: `Host '${host}' is denied by browser host policy`,
      };
    }
  }

  if (policy.allow.length > 0) {
    const allowed = policy.allow.some((pattern) =>
      browserHostMatches(host, pattern),
    );
    if (!allowed) {
      return {
        allowed: false,
        host,
        reason: `Host '${host}' is not allowed by browser host policy`,
      };
    }
  }

  return { allowed: true, host };
}

function disabledResponse(): ToolResponse {
  return {
    content: [{ type: "text", text: BROWSER_DISABLED }],
    isError: true,
  };
}

function humanError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

function isBrowserMissingError(err: unknown): boolean {
  const message = humanError(err, "").toLowerCase();
  return (
    message.includes("executable doesn't exist") ||
    message.includes("browsertype.launch") ||
    (message.includes("chromium") && message.includes("not found")) ||
    message.includes("please run the following command to download") ||
    message.includes("npx playwright install")
  );
}

function playwrightMissingResponse(err: unknown): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text: `${PLAYWRIGHT_INSTALL_HINT} (details: ${humanError(err, "browser launch failed")})`,
      },
    ],
    isError: true,
  };
}

async function ensurePage(headless: boolean): Promise<Page> {
  if (browserInstance && pageInstance && launchedHeadless === headless) {
    return pageInstance;
  }

  if (browserInstance && launchedHeadless !== headless) {
    await closeBrowser();
  }

  const { chromium } = await import("playwright");
  browserInstance = await chromium.launch({ headless });
  browserContext = await browserInstance.newContext();
  await installHostPolicyGuards(browserContext);
  pageInstance = await browserContext.newPage();
  attachPageNavigationGuard(pageInstance);
  launchedHeadless = headless;
  return pageInstance;
}

export async function closeBrowser(): Promise<void> {
  const browser = browserInstance;
  browserInstance = null;
  browserContext = null;
  pageInstance = null;
  launchedHeadless = null;
  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function browser_navigate(args: BrowserNavigateArgs): Promise<ToolResponse> {
  if (!browserEnabled) return disabledResponse();

  const parsed = BrowserNavigateArgsSchema.parse(args);
  const hostDecision = evaluateBrowserHostPolicy(parsed.url);
  if (!hostDecision.allowed) {
    return deniedHostResponse(hostDecision.reason ?? "Browser host denied");
  }

  try {
    const page = await ensurePage(parsed.headless);
    await page.goto(parsed.url, { waitUntil: "load", timeout: 30_000 });
    return {
      content: [
        {
          type: "text",
          text: `Navigated to ${page.url()} (title: ${await page.title()})`,
        },
      ],
    };
  } catch (err) {
    if (isBrowserMissingError(err)) return playwrightMissingResponse(err);
    return {
      content: [
        {
          type: "text",
          text: `Failed to navigate to ${parsed.url}: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}

async function installHostPolicyGuards(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const url = route.request().url();
    const decision = evaluateBrowserHostPolicy(url);
    if (!decision.allowed) {
      browserHostPolicy?.onNavigate?.(url, false, decision.reason);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  context.on("page", (page) => {
    attachPageNavigationGuard(page);
  });
}

function attachPageNavigationGuard(page: Page): void {
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    const decision = evaluateBrowserHostPolicy(url);
    browserHostPolicy?.onNavigate?.(
      url,
      decision.allowed,
      decision.reason,
    );
    if (!decision.allowed) {
      void page.close({ runBeforeUnload: false }).catch(() => {
        // Route guards should block first; closing here is a last-resort fail-closed.
      });
    }
  });
}

function deniedHostResponse(reason: string): ToolResponse {
  return {
    content: [{ type: "text", text: `[NETWORK_DENIED] ${reason}` }],
    isError: true,
  };
}

export async function browser_screenshot(args: BrowserScreenshotArgs): Promise<ToolResponse> {
  if (!browserEnabled) return disabledResponse();

  const parsed = BrowserScreenshotArgsSchema.parse(args);

  if (!pageInstance) {
    return {
      content: [
        {
          type: "text",
          text: "No browser page is open. Call browser_navigate first.",
        },
      ],
      isError: true,
    };
  }

  try {
    const buffer = await pageInstance.screenshot({
      fullPage: parsed.full_page,
      type: "png",
    });
    return {
      content: [
        {
          type: "image",
          data: buffer.toString("base64"),
          mimeType: "image/png",
        },
      ],
    };
  } catch (err) {
    if (isBrowserMissingError(err)) return playwrightMissingResponse(err);
    return {
      content: [
        {
          type: "text",
          text: `Failed to take screenshot: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}

export async function browser_click(args: BrowserClickArgs): Promise<ToolResponse> {
  if (!browserEnabled) return disabledResponse();

  const parsed = BrowserClickArgsSchema.parse(args);

  if (!pageInstance) {
    return {
      content: [
        {
          type: "text",
          text: "No browser page is open. Call browser_navigate first.",
        },
      ],
      isError: true,
    };
  }

  try {
    await pageInstance.click(parsed.selector, { timeout: 10_000 });
    return {
      content: [{ type: "text", text: `Clicked element matching selector: ${parsed.selector}` }],
    };
  } catch (err) {
    if (isBrowserMissingError(err)) return playwrightMissingResponse(err);
    return {
      content: [
        {
          type: "text",
          text: `Failed to click "${parsed.selector}": ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}

export async function browser_evaluate(args: BrowserEvaluateArgs): Promise<ToolResponse> {
  if (!browserEnabled) return disabledResponse();

  const parsed = BrowserEvaluateArgsSchema.parse(args);

  if (!pageInstance) {
    return {
      content: [
        {
          type: "text",
          text: "No browser page is open. Call browser_navigate first.",
        },
      ],
      isError: true,
    };
  }

  try {
    // Evaluate user-supplied expression in page context (string form).
    const result = await pageInstance.evaluate(parsed.code as string);

    let text: string;
    try {
      text = JSON.stringify(result, null, 2) ?? String(result);
    } catch {
      text = String(result);
    }

    return {
      content: [{ type: "text", text }],
    };
  } catch (err) {
    if (isBrowserMissingError(err)) return playwrightMissingResponse(err);
    return {
      content: [
        {
          type: "text",
          text: `Failed to evaluate code: ${humanError(err, "unknown error")}`,
        },
      ],
      isError: true,
    };
  }
}
