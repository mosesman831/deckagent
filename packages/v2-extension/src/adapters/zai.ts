import type { ChatAdapter, InterceptedRequest, InterceptedResponse, ToolCall } from "./types.js";

const TOOL_PATTERN = /<<<TOOL>>>(.*?)<<<END>>>/gs;

const TOOL_SYSTEM_PROMPT =
  "You have access to a local machine through DeckAgent. " +
  "You can use these tools by outputting a JSON block with the format: " +
  '<<<TOOL>>>{"name":"tool_name","args":{...}}<<<END>>>. ' +
  "Available tools: read_file, write_file, edit_file, search_files, list_directory, execute_command, get_environment, browser_navigate, browser_screenshot.";

function tryParseJsonLoose(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Allow single-quoted JSON by converting unescaped single quotes outside
  // double-quoted strings into double quotes.
  let insideDouble = false;
  let escaped = false;
  const chars: string[] = [];
  for (const ch of trimmed) {
    if (escaped) {
      chars.push(ch);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      chars.push(ch);
      escaped = true;
      continue;
    }
    if (ch === '"') {
      insideDouble = !insideDouble;
      chars.push(ch);
      continue;
    }
    if (ch === "'" && !insideDouble) {
      chars.push('"');
      continue;
    }
    chars.push(ch);
  }
  try {
    return JSON.parse(chars.join(""));
  } catch {
    return undefined;
  }
}

function tryParseToolJson(raw: string): ToolCall | null {
  const parsed = tryParseJsonLoose(raw);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name === "string" && typeof obj.args === "object" && obj.args !== null) {
      return { name: obj.name, args: obj.args as Record<string, unknown> };
    }
    if (typeof obj.tool === "string" && typeof obj.args === "object" && obj.args !== null) {
      return { name: obj.tool, args: obj.args as Record<string, unknown> };
    }
  }
  return null;
}

function parseToolCall(matchText: string): ToolCall | null {
  const parsed = tryParseToolJson(matchText);
  if (parsed) return parsed;

  const nameMatch = /["']name["']\s*:\s*["']([^"']+)["']/.exec(matchText);
  const toolMatch = /["']tool["']\s*:\s*["']([^"']+)["']/.exec(matchText);
  const argsMatch = /["']args["']\s*:\s*(\{[\s\S]*\})/.exec(matchText);
  const name = nameMatch?.[1] ?? toolMatch?.[1];

  if (name) {
    const args = tryParseToolJson(argsMatch?.[1] ?? "{}")?.args ?? {};
    return { name, args };
  }

  return null;
}

function ensureToolSystemMessage(messages: Array<Record<string, unknown>>): void {
  const first = messages[0];
  if (first && first.role === "system") {
    const content = typeof first.content === "string" ? first.content : "";
    if (!content.includes("DeckAgent")) {
      first.content = `${TOOL_SYSTEM_PROMPT}\n\n${content}`;
    }
  } else {
    messages.unshift({ role: "system", content: TOOL_SYSTEM_PROMPT });
  }
}

function modifyRequestBody(body: string): string {
  const parsed = JSON.parse(body) as unknown;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).messages)) {
    const obj = parsed as Record<string, unknown>;
    const messages = obj.messages as Array<Record<string, unknown>>;
    ensureToolSystemMessage(messages);
    return JSON.stringify(obj);
  }
  return body;
}

function extractToolCallsFromText(text: string): ToolCall[] | null {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_PATTERN.lastIndex = 0;
  while ((match = TOOL_PATTERN.exec(text)) !== null) {
    const call = parseToolCall(match[1]);
    if (call) calls.push(call);
  }
  return calls.length > 0 ? calls : null;
}

function getString(obj: unknown, ...keys: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function extractTextFromOpenAiChunk(chunk: unknown): string {
  return (
    getString(chunk, "choices", "0", "message", "content") ??
    getString(chunk, "choices", "0", "delta", "content") ??
    ""
  );
}

function extractToolCallsFromContent(content: string): ToolCall[] | null {
  // Streaming SSE body: one or more data: lines
  if (content.trim().startsWith("data:")) {
    const accumulated: string[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (parsed && typeof parsed === "object") {
          accumulated.push(extractTextFromOpenAiChunk(parsed));
        }
      } catch {
        // Ignore malformed SSE chunks
      }
    }
    const full = accumulated.join("");
    if (!full) return null;
    return extractToolCallsFromText(full);
  }

  // Non-streaming JSON body
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      const text = extractTextFromOpenAiChunk(parsed);
      if (text) return extractToolCallsFromText(text);
    }
  } catch {
    // Not JSON — continue to plain text regex below
  }

  return extractToolCallsFromText(content);
}

function appendToolResultToMessages(messages: Array<Record<string, unknown>>, toolContent: string): void {
  messages.push({
    role: "assistant",
    content: `<TOOL_RESULT>${toolContent}</TOOL_RESULT>`,
  });
}

function appendResultToBody(body: string, toolContent: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).messages)) {
      const obj = parsed as Record<string, unknown>;
      appendToolResultToMessages(obj.messages as Array<Record<string, unknown>>, toolContent);
      return JSON.stringify(obj);
    }
  } catch {
    // Ignore malformed bodies
  }
  return body;
}

export const zaiAdapter: ChatAdapter = {
  name: "zai",
  hostPattern: /z\.ai|chatglm\.cn|api\.z\.ai/i,

  match(url: string): boolean {
    return this.hostPattern.test(url);
  },

  transformRequest(request: InterceptedRequest): InterceptedRequest {
    try {
      return { ...request, body: modifyRequestBody(request.body) };
    } catch {
      return request;
    }
  },

  transformResponse(
    _request: InterceptedRequest,
    response: InterceptedResponse
  ): InterceptedResponse {
    return response;
  }
};

export const extractToolCalls = extractToolCallsFromContent;
export const appendToolResult = appendResultToBody;
