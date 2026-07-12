import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { ToolError, toToolError } from '../error.js';
import type { ToolDefinition, ToolContext, ToolResponse } from '../types.js';
import {
  BrowserNavigateArgsSchema,
  BrowserScreenshotArgsSchema,
  BrowserClickArgsSchema,
  BrowserEvaluateArgsSchema,
} from '../schemas.js';

const DEFAULT_CDP_URL = 'http://localhost:29229';

/**
 * BrowserManager lazily connects to (or launches) a Chromium instance via
 * playwright-core and maintains a single reusable page. It prefers connecting
 * to an existing browser over CDP; if that fails it can launch a fresh one.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private connectedOverCdp = false;

  private async ensureBrowser(headless: boolean): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;

    const cdpUrl = process.env.DECKAGENT_CDP_URL || DEFAULT_CDP_URL;
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl);
      this.connectedOverCdp = true;
      return this.browser;
    } catch (cdpErr) {
      try {
        const executablePath = process.env.DECKAGENT_CHROME_PATH;
        this.browser = await chromium.launch({
          headless,
          ...(executablePath ? { executablePath } : {}),
        });
        this.connectedOverCdp = false;
        return this.browser;
      } catch (launchErr) {
        throw new ToolError(
          'INTERNAL_ERROR',
          `Unable to connect to a browser over CDP (${cdpUrl}) or launch one. ` +
            `Set DECKAGENT_CDP_URL or DECKAGENT_CHROME_PATH. ` +
            `CDP error: ${(cdpErr as Error).message}. Launch error: ${(launchErr as Error).message}.`,
        );
      }
    }
  }

  private async ensurePage(headless: boolean): Promise<Page> {
    const browser = await this.ensureBrowser(headless);
    if (this.page && !this.page.isClosed()) return this.page;

    if (this.connectedOverCdp) {
      const contexts = browser.contexts();
      const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
      const pages = context.pages();
      this.page = pages.length > 0 ? pages[0] : await context.newPage();
    } else {
      this.page = await browser.newPage();
    }
    return this.page;
  }

  async navigate(url: string, headless: boolean): Promise<{ title: string; screenshot: string }> {
    const page = await this.ensurePage(headless);
    await page.goto(url, { waitUntil: 'load' });
    const title = await page.title();
    const buf = await page.screenshot({ type: 'png' });
    return { title, screenshot: buf.toString('base64') };
  }

  async screenshot(fullPage: boolean): Promise<string> {
    if (!this.page || this.page.isClosed()) {
      throw new ToolError('INTERNAL_ERROR', 'No active page. Call browser_navigate first.');
    }
    const buf = await this.page.screenshot({ type: 'png', fullPage });
    return buf.toString('base64');
  }

  async click(selector: string): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      throw new ToolError('INTERNAL_ERROR', 'No active page. Call browser_navigate first.');
    }
    await this.page.click(selector);
  }

  async evaluate(code: string): Promise<string> {
    if (!this.page || this.page.isClosed()) {
      throw new ToolError('INTERNAL_ERROR', 'No active page. Call browser_navigate first.');
    }
    const result: unknown = await this.page.evaluate(code);
    if (result === undefined) return 'undefined';
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  async close(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => undefined);
    }
    this.page = null;
    if (this.browser && this.browser.isConnected()) {
      await this.browser.close().catch(() => undefined);
    }
    this.browser = null;
  }
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the browser and return the page title plus a base64 PNG screenshot.',
    inputSchema: BrowserNavigateArgsSchema,
    handler: async (args, context: ToolContext): Promise<ToolResponse> => {
      try {
        const { title, screenshot } = await context.browserManager.navigate(args.url, args.headless);
        return {
          content: [
            { type: 'text', text: `Title: ${title}` },
            { type: 'text', text: `Screenshot (base64 PNG): ${screenshot}` },
          ],
        };
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser page and return it as base64 PNG.',
    inputSchema: BrowserScreenshotArgsSchema,
    handler: async (args, context: ToolContext): Promise<ToolResponse> => {
      try {
        const screenshot = await context.browserManager.screenshot(args.full_page);
        return { content: [{ type: 'text', text: `Screenshot: ${screenshot}` }] };
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page identified by a CSS selector.',
    inputSchema: BrowserClickArgsSchema,
    handler: async (args, context: ToolContext): Promise<ToolResponse> => {
      try {
        await context.browserManager.click(args.selector);
        return { content: [{ type: 'text', text: `Clicked element: ${args.selector}` }] };
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the current page context and return the result.',
    inputSchema: BrowserEvaluateArgsSchema,
    handler: async (args, context: ToolContext): Promise<ToolResponse> => {
      try {
        const result = await context.browserManager.evaluate(args.code);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        throw toToolError(err);
      }
    },
  },
];
