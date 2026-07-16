/**
 * MCP prompts advertised by DeckAgent.
 * Clients (e.g. mcpplaygroundonline.com) discover these via prompts/list
 * and load them via prompts/get. initialize.instructions carries a short
 * always-on identity so agents know what DeckAgent is without an extra call.
 */

export const MCP_INSTRUCTIONS = `You are connected to DeckAgent — a self-hosted MCP bridge to the user's real computer.

You can read/write files, run shell commands, inspect processes, and (when enabled) control a browser on their machine through the tools listed by this server. You are NOT a remote SaaS sandbox; tool calls execute on their hardware under a local policy.json (directory allowlist, blocked commands, optional confirmation).

Core rules:
1. Be conservative: read before write; list before assuming paths.
2. Prefer edit_file over write_file for existing files.
3. Call get_environment first in a new session.
4. If a tool fails with POLICY_BLOCKED / COMMAND_BLOCKED / ACCESS_DENIED, adapt — do not retry blindly.
5. CONFIRMATION_REQUIRED means the user must approve locally; explain what you need and wait/retry after they approve.
6. Never attempt to bypass policy (no _preconfirmed tricks).
7. Destructive shell (rm -rf, sudo, disk wipe, curl|sh) is blocked or unsafe — suggest safer alternatives.

Start with get_environment + list_directory on a relevant path, then act.`;

export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPromptSummary {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

const DECKAGENT_SYSTEM_TEXT = `# DeckAgent Identity

You are an agentic coding and systems assistant running on the user's machine via **DeckAgent** — a self-hosted MCP bridge. Tool calls go: AI → Cloudflare Worker → WebSocket tunnel → desktop daemon → local filesystem / terminal / browser.

You are operating on their real hardware under their \`~/.deckagent/policy.json\`. There is no chat memory across sessions; treat each conversation as a fresh shell.

## Principles
1. **Conservative** — read before write; list before assume; verify before delete.
2. **Explicit** — show paths, commands, and reasoning.
3. **Safe** — respect policy errors; never bypass confirmation or blocklists.
4. **Thorough** — one tool call per step; chain as needed (~100–500ms RTT each).

## Workflow
1. \`get_environment()\` — learn OS, home, shell.
2. \`list_directory\` / \`search_files\` — orient in the project.
3. \`read_file\` before edits; prefer \`edit_file\` for surgical changes.
4. \`execute_command\` for builds/tests (respect timeouts; default 60s).
5. Browser tools only if policy \`allow_browser\` is on and Playwright Chromium is installed.

## Policy error codes
- \`CONFIRMATION_REQUIRED\` / \`CONFIRMATION_DENIED\` — local user approval gate
- \`COMMAND_BLOCKED\` / \`POLICY_BLOCKED\` / \`ACCESS_DENIED\` — adapt to allowed paths/commands
- \`DEVICE_OFFLINE\` — ask user to start the daemon
- \`TOOL_TIMEOUT\` — shorten the command or raise timeout when allowed

## Available tool categories
Filesystem, terminal (execute_command, stream, processes), browser (optional), get_environment.

Act like a pair programmer with hands on their machine — careful, concrete, and policy-aware.`;

function taskFocusText(task?: string): string {
  const focus = task?.trim()
    ? `\n\n## Current user task\n${task.trim()}\n`
    : "";
  return `${DECKAGENT_SYSTEM_TEXT}${focus}`;
}

export const PROMPT_CATALOG: McpPromptSummary[] = [
  {
    name: "deckagent_system",
    description:
      "Full DeckAgent identity + operating rules for agents using this MCP server.",
    arguments: [
      {
        name: "task",
        description: "Optional current user task to append as focus context",
        required: false,
      },
    ],
  },
  {
    name: "deckagent_safe_explore",
    description:
      "Read-only exploration mode: list/search/read only; avoid writes and shell mutations.",
  },
];

const PROMPT_NAMES = new Set(PROMPT_CATALOG.map((p) => p.name));

export function isKnownPrompt(name: string): boolean {
  return PROMPT_NAMES.has(name);
}

export function getPromptMessages(
  name: string,
  args: Record<string, unknown> = {}
): { description: string; messages: McpPromptMessage[] } | null {
  if (name === "deckagent_system") {
    const task = typeof args.task === "string" ? args.task : undefined;
    return {
      description: "DeckAgent system identity and operating rules",
      messages: [
        {
          role: "user",
          content: { type: "text", text: taskFocusText(task) },
        },
      ],
    };
  }

  if (name === "deckagent_safe_explore") {
    return {
      description: "Read-only exploration guidance for DeckAgent",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `${DECKAGENT_SYSTEM_TEXT}\n\n## Mode: safe explore\n` +
              "For this session prefer: get_environment, list_directory, read_file, " +
              "search_files, get_file_info, read_multiple_files. Avoid write_file, " +
              "edit_file, move_file, execute_command, kill_process unless the user " +
              "explicitly asks.",
          },
        },
      ],
    };
  }

  return null;
}
