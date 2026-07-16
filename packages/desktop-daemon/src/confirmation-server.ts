import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

export const CONFIRMATION_HOST = "127.0.0.1";
export const CONFIRMATION_PORT = 9148;
export const CONFIRMATION_WAIT_MS = 90_000;
export const CONFIRMATION_EXPIRE_MS = 60_000;

export type ApprovalDecision = "approved" | "denied" | "expired" | "timeout";

interface PendingApproval {
  id: string;
  tool: string;
  argsSummary: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  decision: ApprovalDecision | null;
  resolveWaiters: Array<(decision: ApprovalDecision) => void>;
}

export class ConfirmationServer {
  private server: Server | null = null;
  private pending = new Map<string, PendingApproval>();
  private logger: Logger;
  private host: string;
  private port: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    logger: Logger,
    options?: { host?: string; port?: number },
  ) {
    this.logger = logger;
    this.host = options?.host ?? CONFIRMATION_HOST;
    this.port = options?.port ?? CONFIRMATION_PORT;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        this.logger.error(
          `Confirmation server error: ${err instanceof Error ? err.message : String(err)}`,
        );
        reject(err);
      });

      server.listen(this.port, this.host, () => {
        this.server = server;
        this.logger.info(
          `Confirmation server listening on ${this.baseUrl}`,
        );
        resolve();
      });
    });

    this.cleanupTimer = setInterval(() => this.expireStale(), 5_000);
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const approval of this.pending.values()) {
      this.settle(approval, "expired");
    }
    this.pending.clear();

    const server = this.server;
    this.server = null;
    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /**
   * Create a pending approval and return its local confirm URL.
   * Call waitForDecision() to block until approve/deny/timeout.
   */
  createApproval(options: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    expireMs?: number;
  }): { id: string; url: string; expiresAt: number } {
    const id = randomUUID();
    const now = Date.now();
    const expireMs = options.expireMs ?? CONFIRMATION_EXPIRE_MS;
    const approval: PendingApproval = {
      id,
      tool: options.tool,
      argsSummary: summarizeArgs(options.args),
      reason: options.reason,
      createdAt: now,
      expiresAt: now + expireMs,
      decision: null,
      resolveWaiters: [],
    };
    this.pending.set(id, approval);

    const url = `${this.baseUrl}/confirm/${id}`;
    return { id, url, expiresAt: approval.expiresAt };
  }

  /**
   * Wait for a decision on an existing approval.
   * Resolves with approved | denied | expired | timeout.
   */
  waitForDecision(
    id: string,
    timeoutMs: number = CONFIRMATION_WAIT_MS,
  ): Promise<ApprovalDecision> {
    const approval = this.pending.get(id);
    if (!approval) {
      return Promise.resolve("expired");
    }
    if (approval.decision) {
      return Promise.resolve(approval.decision);
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!approval.decision) {
          this.settle(approval, "timeout");
        }
      }, timeoutMs);

      approval.resolveWaiters.push((decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
    });
  }

  /** Best-effort open the confirmation URL in the system browser. */
  openInBrowser(url: string): void {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // Ignore — user can open the URL manually.
      });
      child.unref();
    } catch {
      // Ignore failures.
    }
  }

  /** Test helper: approve without HTTP. */
  approveForTest(id: string): boolean {
    const approval = this.pending.get(id);
    if (!approval || approval.decision) return false;
    this.settle(approval, "approved");
    return true;
  }

  /** Test helper: deny without HTTP. */
  denyForTest(id: string): boolean {
    const approval = this.pending.get(id);
    if (!approval || approval.decision) return false;
    this.settle(approval, "denied");
    return true;
  }

  getPending(id: string): PendingApproval | undefined {
    return this.pending.get(id);
  }

  private settle(approval: PendingApproval, decision: ApprovalDecision): void {
    if (approval.decision) return;
    approval.decision = decision;
    const waiters = approval.resolveWaiters.splice(0);
    for (const resolve of waiters) {
      resolve(decision);
    }
    // Keep record briefly for late GET; cleanup removes it.
    if (decision === "expired" || decision === "timeout") {
      this.pending.delete(approval.id);
    }
  }

  private expireStale(): void {
    const now = Date.now();
    for (const approval of Array.from(this.pending.values())) {
      if (!approval.decision && now > approval.expiresAt) {
        this.settle(approval, "expired");
      } else if (
        approval.decision &&
        now > approval.expiresAt + 30_000
      ) {
        this.pending.delete(approval.id);
      }
    }
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const method = (req.method || "GET").toUpperCase();

    // CORS not needed — localhost only.
    try {
      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      const confirmMatch = url.pathname.match(
        /^\/confirm\/([0-9a-fA-F-]{36})$/,
      );
      const actionMatch = url.pathname.match(
        /^\/confirm\/([0-9a-fA-F-]{36})\/(approve|deny)$/,
      );

      if (method === "GET" && confirmMatch) {
        const id = confirmMatch[1]!;
        this.renderConfirmPage(res, id);
        return;
      }

      if (
        (method === "POST" || method === "GET") &&
        actionMatch
      ) {
        const id = actionMatch[1]!;
        const action = actionMatch[2] as "approve" | "deny";
        this.handleDecision(res, id, action === "approve" ? "approved" : "denied");
        return;
      }

      sendHtml(res, 404, "<h1>Not found</h1>");
    } catch (err) {
      this.logger.error(
        `Confirmation request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendHtml(res, 500, "<h1>Internal error</h1>");
    }
  }

  private handleDecision(
    res: ServerResponse,
    id: string,
    decision: "approved" | "denied",
  ): void {
    const approval = this.pending.get(id);
    if (!approval) {
      sendHtml(
        res,
        404,
        htmlPage(
          "Request not found",
          "<p>This confirmation request expired or does not exist.</p>",
        ),
      );
      return;
    }

    if (approval.decision) {
      sendHtml(
        res,
        200,
        htmlPage(
          "Already decided",
          `<p>This request was already <strong>${approval.decision}</strong>.</p>`,
        ),
      );
      return;
    }

    if (Date.now() > approval.expiresAt) {
      this.settle(approval, "expired");
      sendHtml(
        res,
        410,
        htmlPage("Expired", "<p>This confirmation request has expired.</p>"),
      );
      return;
    }

    this.settle(approval, decision);
    this.logger.info(
      `Confirmation ${decision} for tool '${approval.tool}' (${id})`,
    );

    sendHtml(
      res,
      200,
      htmlPage(
        decision === "approved" ? "Approved" : "Denied",
        `<p>Tool <code>${escapeHtml(approval.tool)}</code> was <strong>${decision}</strong>.</p>
         <p>You can close this window. The daemon will continue.</p>`,
      ),
    );
  }

  private renderConfirmPage(res: ServerResponse, id: string): void {
    const approval = this.pending.get(id);
    if (!approval) {
      sendHtml(
        res,
        404,
        htmlPage(
          "Request not found",
          "<p>This confirmation request expired or does not exist.</p>",
        ),
      );
      return;
    }

    if (approval.decision) {
      sendHtml(
        res,
        200,
        htmlPage(
          "Already decided",
          `<p>This request was already <strong>${escapeHtml(approval.decision)}</strong>.</p>`,
        ),
      );
      return;
    }

    if (Date.now() > approval.expiresAt) {
      this.settle(approval, "expired");
      sendHtml(
        res,
        410,
        htmlPage("Expired", "<p>This confirmation request has expired.</p>"),
      );
      return;
    }

    const remainingSec = Math.max(
      0,
      Math.ceil((approval.expiresAt - Date.now()) / 1000),
    );

    sendHtml(
      res,
      200,
      htmlPage(
        "Approve tool execution?",
        `
        <p><strong>DeckAgent</strong> needs your approval to run a tool on this machine.</p>
        <dl>
          <dt>Tool</dt><dd><code>${escapeHtml(approval.tool)}</code></dd>
          <dt>Reason</dt><dd>${escapeHtml(approval.reason)}</dd>
          <dt>Args</dt><dd><pre>${escapeHtml(approval.argsSummary)}</pre></dd>
          <dt>Expires</dt><dd>~${remainingSec}s</dd>
        </dl>
        <form method="POST" action="/confirm/${id}/approve" style="display:inline">
          <button type="submit" style="background:#1a7f37;color:#fff;padding:10px 18px;border:0;cursor:pointer;font-size:16px">Approve</button>
        </form>
        <form method="POST" action="/confirm/${id}/deny" style="display:inline;margin-left:12px">
          <button type="submit" style="background:#cf222e;color:#fff;padding:10px 18px;border:0;cursor:pointer;font-size:16px">Deny</button>
        </form>
        `,
      ),
    );
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const sanitized: Record<string, unknown> = { ...args };
  delete sanitized._preconfirmed;
  // Truncate large content fields
  for (const key of Object.keys(sanitized)) {
    const value = sanitized[key];
    if (typeof value === "string" && value.length > 200) {
      sanitized[key] = value.slice(0, 200) + "…";
    }
  }
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return String(sanitized);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)} — DeckAgent</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1f2328; }
    h1 { font-size: 1.4rem; }
    code, pre { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 0.9rem; }
    pre { padding: 12px; overflow: auto; }
    dt { font-weight: 600; margin-top: 12px; }
    dd { margin: 4px 0 0 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html, "utf-8");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}
