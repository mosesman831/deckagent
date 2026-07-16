import type { Env } from "./types.js";
import { MCP_INSTRUCTIONS } from "./prompt-catalog.js";
import {
  getPreferredDeviceId,
  listDevices,
} from "./device-registry.js";

export interface McpResourceSummary {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/** Resources advertised via resources/list. */
export const RESOURCE_CATALOG: McpResourceSummary[] = [
  {
    uri: "deckagent://about",
    name: "About DeckAgent",
    description:
      "Short identity and how to use this self-hosted MCP bridge.",
    mimeType: "text/markdown",
  },
  {
    uri: "deckagent://session/instructions",
    name: "Session instructions",
    description:
      "Always-on operating instructions (same as initialize.instructions).",
    mimeType: "text/markdown",
  },
  {
    uri: "deckagent://policy",
    name: "Daemon policy",
    description:
      "Current local policy.json (secrets redacted). Requires an online daemon.",
    mimeType: "application/json",
  },
  {
    uri: "deckagent://workspace",
    name: "Active workspace",
    description:
      "Active project workspace root and name from the daemon config.",
    mimeType: "application/json",
  },
  {
    uri: "deckagent://devices",
    name: "Devices",
    description: "Registered and online DeckAgent devices for this Worker.",
    mimeType: "application/json",
  },
  {
    uri: "deckagent://audit/recent",
    name: "Recent audit log",
    description:
      "Last N audit log lines from the daemon (secrets redacted). NDJSON.",
    mimeType: "application/x-ndjson",
  },
];

const CATALOG_BY_URI = new Map(RESOURCE_CATALOG.map((r) => [r.uri, r]));

/** URIs served entirely by the Worker (no daemon round-trip). */
export const STATIC_RESOURCE_URIS = new Set([
  "deckagent://about",
  "deckagent://session/instructions",
  "deckagent://devices",
]);

/** URIs that must be fetched from the desktop daemon over the tunnel. */
export const DAEMON_RESOURCE_URIS = new Set([
  "deckagent://policy",
  "deckagent://workspace",
  "deckagent://audit/recent",
]);

export function isKnownResourceUri(uri: string): boolean {
  return CATALOG_BY_URI.has(uri);
}

export function isStaticResourceUri(uri: string): boolean {
  return STATIC_RESOURCE_URIS.has(uri);
}

export function isDaemonResourceUri(uri: string): boolean {
  return DAEMON_RESOURCE_URIS.has(uri);
}

const ABOUT_MARKDOWN = `# About DeckAgent

DeckAgent is a **self-hosted MCP bridge** between ChatGPT / Claude / Cursor and your real computer.

Architecture: AI client → Cloudflare Worker (\`/mcp\`) → WebSocket tunnel → desktop daemon → local filesystem, terminal, and optional browser tools.

- Tools run on **your** machine under \`~/.deckagent/policy.json\` (directory allowlist, blocked commands, confirmation).
- This Worker is the public MCP endpoint; policy and secrets never leave the daemon.
- Start a session with \`get_environment\`, then explore with \`list_directory\` / \`read_file\`.
- Pull live context via MCP resources: \`deckagent://policy\`, \`deckagent://workspace\`, \`deckagent://devices\`, \`deckagent://audit/recent\`.
`;

/**
 * Resolve a Worker-served (static) resource into MCP contents.
 * Returns null for unknown or daemon-only URIs.
 */
export async function readStaticResource(
  uri: string,
  env: Env
): Promise<McpResourceContents | null> {
  const meta = CATALOG_BY_URI.get(uri);
  if (!meta || !STATIC_RESOURCE_URIS.has(uri)) return null;

  if (uri === "deckagent://about") {
    return { uri, mimeType: meta.mimeType, text: ABOUT_MARKDOWN };
  }

  if (uri === "deckagent://session/instructions") {
    return { uri, mimeType: meta.mimeType, text: MCP_INSTRUCTIONS };
  }

  if (uri === "deckagent://devices") {
    const text = await buildDevicesJson(env);
    return { uri, mimeType: meta.mimeType, text };
  }

  return null;
}

async function buildDevicesJson(env: Env): Promise<string> {
  return JSON.stringify(
    {
      preferred_device_id: await getPreferredDeviceId(env),
      devices: await listDevices(env),
    },
    null,
    2
  );
}
