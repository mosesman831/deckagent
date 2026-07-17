import type { Policy, WorkspacePolicy } from "./policy.js";
import { readRecentAuditLog } from "./audit-log.js";

export interface ResourceTemplate {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export type ResourceReadResult =
  | { ok: true; contents: ResourceContents[] }
  | { ok: false; code: string; message: string };

export interface ResourceReadOptions {
  policy: Policy;
  workspace?: WorkspacePolicy | null;
  auditLogDir?: string;
}

/** Daemon-local MCP resource templates (policy / workspace / audit). */
export function listLocalResourceTemplates(): ResourceTemplate[] {
  return [
    {
      uri: "deckagent://policy",
      name: "policy",
      description: "Current daemon policy (secrets redacted)",
      mimeType: "application/json",
    },
    {
      uri: "deckagent://workspace",
      name: "workspace",
      description: "Active workspace from daemon config",
      mimeType: "application/json",
    },
    {
      uri: "deckagent://audit/recent",
      name: "audit/recent",
      description: "Recent audit log lines (NDJSON, last N entries)",
      mimeType: "application/x-ndjson",
    },
  ];
}

/**
 * Read a daemon-local resource by URI.
 * Supported: deckagent://policy | workspace | audit/recent
 */
export function readLocalResource(
  uri: string,
  args: Record<string, unknown> | undefined,
  options: ResourceReadOptions,
): ResourceReadResult {
  const normalized = uri.trim().replace(/\/+$/, "");

  switch (normalized) {
    case "deckagent://policy":
      return {
        ok: true,
        contents: [
          {
            uri: "deckagent://policy",
            mimeType: "application/json",
            text: JSON.stringify(redactPolicyForResource(options.policy), null, 2),
          },
        ],
      };

    case "deckagent://workspace": {
      const workspace = options.workspace;
      const payload = workspace
        ? {
            root: workspace.root,
            name: workspace.name,
            allow_outside_with_confirmation:
              workspace.allow_outside_with_confirmation,
          }
        : { root: null };
      return {
        ok: true,
        contents: [
          {
            uri: "deckagent://workspace",
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }

    case "deckagent://audit/recent": {
      const limit =
        typeof args?.limit === "number"
          ? args.limit
          : typeof args?.limit === "string"
            ? Number(args.limit)
            : undefined;
      const text = readRecentAuditLog({
        limit,
        logDir: options.auditLogDir,
      });
      return {
        ok: true,
        contents: [
          {
            uri: "deckagent://audit/recent",
            mimeType: "application/x-ndjson",
            text,
          },
        ],
      };
    }

    default:
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `Unknown or unsupported resource URI: ${uri}`,
      };
  }
}

/** Policy JSON for resources — strip any future secret-like fields. */
function redactPolicyForResource(policy: Policy): Policy {
  // Policy has no secret values today; return a shallow copy for safety.
  return { ...policy };
}
