import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

export const CONFIRMATION_HOST = "127.0.0.1";
export const CONFIRMATION_PORT = 9148;
export const CONFIRMATION_WAIT_MS = 90_000;
export const CONFIRMATION_EXPIRE_MS = 60_000;

export type ApprovalDecision = "approved" | "denied" | "expired" | "timeout";

export interface ApprovalDiff {
  path: string;
  language?: string;
  before: string;
  after: string;
  unified: string;
}

export interface PendingApproval {
  id: string;
  tool: string;
  argsSummary: string;
  reason: string;
  diff?: ApprovalDiff;
  csrfToken: string;
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
    diff?: ApprovalDiff;
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
      ...(options.diff ? { diff: options.diff } : {}),
      csrfToken: randomBytes(32).toString("hex"),
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
    return this.approve(id);
  }

  /** Test helper: deny without HTTP. */
  denyForTest(id: string): boolean {
    return this.deny(id);
  }

  /** Approve a pending request (control UI / tests). */
  approve(id: string): boolean {
    const approval = this.pending.get(id);
    if (!approval || approval.decision) return false;
    this.settle(approval, "approved");
    return true;
  }

  /** Deny a pending request (control UI / tests). */
  deny(id: string): boolean {
    const approval = this.pending.get(id);
    if (!approval || approval.decision) return false;
    this.settle(approval, "denied");
    return true;
  }

  getPending(id: string): PendingApproval | undefined {
    return this.pending.get(id);
  }

  /** Pending approvals awaiting a decision (for control UI). */
  listPending(): Array<{
    id: string;
    tool: string;
    argsSummary: string;
    reason: string;
    diff?: ApprovalDiff;
    createdAt: number;
    expiresAt: number;
  }> {
    const now = Date.now();
    const out: Array<{
      id: string;
      tool: string;
      argsSummary: string;
      reason: string;
      diff?: ApprovalDiff;
      createdAt: number;
      expiresAt: number;
    }> = [];
    for (const approval of this.pending.values()) {
      if (approval.decision) continue;
      if (now > approval.expiresAt) continue;
      out.push({
        id: approval.id,
        tool: approval.tool,
        argsSummary: approval.argsSummary,
        reason: approval.reason,
        ...(approval.diff ? { diff: approval.diff } : {}),
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Count of undecided, non-expired approvals. */
  pendingCount(): number {
    return this.listPending().length;
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

    try {
      if (!requestHasLoopbackProvenance(req)) {
        sendHtml(
          res,
          403,
          htmlPage(
            "Forbidden",
            "<p>DeckAgent confirmation requests are accepted only from loopback pages.</p>",
          ),
        );
        return;
      }

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

      if (method === "GET" && actionMatch) {
        sendHtml(
          res,
          405,
          htmlPage(
            "Use the confirmation form",
            "<p>Approval decisions must be submitted from the confirmation form.</p>",
          ),
        );
        return;
      }

      if (method === "POST" && actionMatch) {
        const id = actionMatch[1]!;
        const action = actionMatch[2] as "approve" | "deny";
        await this.handleDecision(
          req,
          res,
          id,
          action === "approve" ? "approved" : "denied",
        );
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
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    decision: "approved" | "denied",
  ): Promise<void> {
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
      return Promise.resolve();
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
      return Promise.resolve();
    }

    if (Date.now() > approval.expiresAt) {
      this.settle(approval, "expired");
      sendHtml(
        res,
        410,
        htmlPage("Expired", "<p>This confirmation request has expired.</p>"),
      );
      return Promise.resolve();
    }

    return readFormBody(req).then((body) => {
      const csrf = firstHeader(req.headers["x-deckagent-csrf"]) ?? body.get("csrf");
      if (csrf !== approval.csrfToken) {
        sendHtml(
          res,
          403,
          htmlPage(
            "Forbidden",
            "<p>Invalid or missing confirmation CSRF token. Reopen the confirmation form and try again.</p>",
          ),
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
    }).catch((err) => {
      this.logger.warn(
        `Confirmation form parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendHtml(
        res,
        400,
        htmlPage("Invalid request", "<p>Could not read confirmation form data.</p>"),
      );
    });
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
    const preview = approval.diff
      ? `
          <p class="label">Diff preview</p>
          <p class="path">${escapeHtml(approval.diff.path)}</p>
          <pre class="diff">${escapeHtml(approval.diff.unified)}</pre>
        `
      : `
          <p class="label">Arguments</p>
          <pre class="args">${escapeHtml(approval.argsSummary)}</pre>
        `;

    sendHtml(
      res,
      200,
      htmlPage(
        "Approve tool execution?",
        `
        <p><strong>DeckAgent</strong> needs your approval to run a tool on this machine.</p>
        <div class="panel">
          <p class="tool-name">Tool: <code>${escapeHtml(approval.tool)}</code></p>
          <p class="reason">${escapeHtml(approval.reason)}</p>
          ${preview}
          <p class="expires">Expires in ~${remainingSec}s</p>
        </div>
        <form method="POST" action="/confirm/${id}/approve" style="display:inline">
          <input type="hidden" name="csrf" value="${escapeHtml(approval.csrfToken)}"/>
          <button type="submit" class="btn approve">Approve</button>
        </form>
        <form method="POST" action="/confirm/${id}/deny" style="display:inline;margin-left:12px">
          <input type="hidden" name="csrf" value="${escapeHtml(approval.csrfToken)}"/>
          <button type="submit" class="btn deny">Deny</button>
        </form>
        `,
      ),
    );
  }
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
}

function requestHasLoopbackProvenance(req: IncomingMessage): boolean {
  const host = firstHeader(req.headers.host);
  if (!host || !isLoopbackAuthority(host)) return false;

  const origin = firstHeader(req.headers.origin);
  if (origin && !isLoopbackUrl(origin)) return false;

  const referer = firstHeader(req.headers.referer);
  if (referer && !isLoopbackUrl(referer)) return false;

  return true;
}

function firstHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackAuthority(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  try {
    return isLoopbackHostname(new URL(`http://${raw}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function summarizeArgs(args: Record<string, unknown>): string {
  const sanitized: Record<string, unknown> = { ...args };
  delete sanitized._preconfirmed;
  delete sanitized.preconfirmed;
  delete sanitized.__preconfirmed;
  for (const key of Object.keys(sanitized)) {
    if (/^(token|password|secret|api[_-]?key|authorization|bearer|credential)$/i.test(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }
    const value = sanitized[key];
    if (typeof value === "string" && value.length > 200) {
      sanitized[key] = redactSecretLikeLines(value.slice(0, 200)) + "…";
    } else if (typeof value === "string") {
      sanitized[key] = redactSecretLikeLines(value);
    }
  }
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return String(sanitized);
  }
}

export function redactSecretLikeLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const content = line.replace(/^([ +\-])/, "");
      if (SECRET_LIKE_LINE_RE.test(content)) {
        const prefix = line.match(/^([ +\-])/)?.[1] ?? "";
        return `${prefix}[redacted secret-like line]`;
      }
      return line;
    })
    .join("\n");
}

const SECRET_LIKE_LINE_RE =
  /\b(api[_-]?key|token|secret|password|authorization|bearer|credential)\b/i;

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
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 16px; color: #1f2328; background: #f6f8fa; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    .panel { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px 18px; margin: 16px 0 20px; }
    .tool-name { font-size: 1.05rem; margin: 0 0 8px; }
    .reason { color: #57606a; margin: 0 0 12px; }
    .label { font-weight: 600; margin: 0 0 6px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.02em; color: #57606a; }
    code, pre.args, pre.diff { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 0.9rem; }
    pre.args, pre.diff { padding: 12px; overflow: auto; margin: 0 0 12px; border: 1px solid #eaeef2; white-space: pre-wrap; word-break: break-word; }
    pre.diff { max-height: 420px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; background: #0d1117; color: #e6edf3; }
    .path { margin: -2px 0 8px; color: #57606a; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; word-break: break-all; }
    .expires { margin: 0; color: #57606a; font-size: 0.9rem; }
    .btn { color: #fff; padding: 10px 18px; border: 0; cursor: pointer; font-size: 16px; border-radius: 6px; }
    .btn.approve { background: #1a7f37; }
    .btn.deny { background: #cf222e; }
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
