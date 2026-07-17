import type { ChatAdapter, InterceptedRequest, InterceptedResponse, ToolCall } from "./types.js";

const TOOL_PATTERN = /<<<TOOL>>>(.*?)<<<END>>>/gs;

const TOOL_SYSTEM_PROMPT =
  "You have access to a local machine through DeckAgent. " +
  "You can use these tools by outputting a JSON block with the format: " +
  '<<<TOOL>>>{"name":"tool_name","args":{...}}<<<END>>>. ' +
  "Available tools: read_file, write_file, edit_file, search_files, list_directory, execute_command, get_environment, browser_navigate, browser_screenshot.";

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

function tryParseToolJson(raw: string): ToolCall | null {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.name === "string" && typeof obj.args === "object" && obj.args !== null) {
        return { name: obj.name, args: obj.args as Record<string, unknown> };
      }
    }
  } catch {
    // fall through to regex heuristic
  }
  return null;
}

function parseToolCall(matchText: string): ToolCall | null {
  const parsed = tryParseToolJson(matchText);
  if (parsed) return parsed;

  // Loose heuristic for common variants (e.g. {"tool":"...","args":{...}})
  const nameMatch = /["']name["']\s*:\s*["']([^"']+)["']/.exec(matchText);
  const argsMatch = /["']args["']\s*:\s*(\{[\s\S]*\})/.exec(matchText);
  const toolMatch = /["']tool["']\s*:\s*["']([^"']+)["']/.exec(matchText);

  if (nameMatch) {
    const args = tryParseToolJson(argsMatch?.[1] ?? "{}")?.args ?? {};
    return { name: nameMatch[1], args };
  }

  if (toolMatch) {
    const args = tryParseToolJson(argsMatch?.[1] ?? "{}")?.args ?? {};
    return { name: toolMatch[1], args };
  }

  return null;
}

function appendToolResultToMessages(
  messages: Array<Record<string, unknown>>,
  toolContent: string,
): void {
  messages.push({
    role: "assistant",
    content: `<TOOL_RESULT>${toolContent}</TOOL_RESULT>`,
  });
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

function extractToolCallsFromText(responseBody: string): ToolCall[] | null {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_PATTERN.lastIndex = 0;
  while ((match = TOOL_PATTERN.exec(responseBody)) !== null) {
    const call = parseToolCall(match[1]);
    if (call) calls.push(call);
  }
  return calls.length > 0 ? calls : null;
}

function extractToolCallsFromContent(content: string): ToolCall[] | null {
  // Streaming SSE body: one or more data: lines
  if (content.startsWith("data:")) {
    const chunks = content.split(/\n/);
    const accumulated: string[] = [];
    for (const line of chunks) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") break;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (parsed && typeof parsed === "object") {
          const choices = (parsed as Record<string, unknown>).choices;
          if (Array.isArray(choices) && choices[0]) {
            const delta = (choices[0] as Record<string, unknown>).delta;
            if (delta && typeof (delta as Record<string, unknown>).content === "string") {
              accumulated.push((delta as Record<string, unknown>).content as string);
            }
          }
        }
      } catch {
        // Ignore malformed SSE chunks
      }
    }
    const full = accumulated.join("");
    return extractToolCallsFromText(full);
  }

  // Non-streaming JSON body
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      const choices = (parsed as Record<string, unknown>).choices;
      if (Array.isArray(choices) && choices[0]) {
        const message = (choices[0] as Record<string, unknown>).message as
          | Record<string, unknown>
          | undefined;
        if (message && typeof message.content === "string") {
          return extractToolCallsFromText(message.content);
        }
      }
    }
  } catch {
    // Not JSON — continue to plain text regex below
  }

  return extractToolCallsFromText(content);
}

function appendResultToBody(body: string, toolContent: string): string {
  if (!body.trim()) return body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).messages)) {
      const obj = parsed as Record<string, unknown>;
      appendToolResultToMessages(obj.messages as Array<Record<string, unknown>>, toolContent);
      return JSON.stringify(obj);
    }
  } catch {
    // fall through and return original body
  }
  return body;
}

export const DeepSeekAdapter: ChatAdapter = {
  name: "deepseek",
  hostPattern: /^https:\/\/(chat\.)?deepseek\.com/i,

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
