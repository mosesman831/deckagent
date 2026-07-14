export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AdapterMessage {
  id: string;
  type: "request" | "response" | "event" | "error";
  payload: unknown;
  timestamp: number;
  source: "content-script" | "background" | "daemon" | "page";
}

export interface InterceptedRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
  adapterType: string;
}

export interface InterceptedResponse {
  id: string;
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
}

export interface DaemonMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: DaemonError;
}

export interface DaemonError {
  code: number;
  message: string;
  data?: unknown;
}

export interface ChatAdapter {
  readonly name: string;
  readonly hostPattern: RegExp;
  match(url: string): boolean;
  transformRequest?(request: InterceptedRequest): InterceptedRequest | Promise<InterceptedRequest>;
  transformResponse?(
    request: InterceptedRequest,
    response: InterceptedResponse
  ): InterceptedResponse | Promise<InterceptedResponse>;
}

export interface FetchMonkeyPatchContext {
  originalFetch: typeof fetch;
  report: (message: AdapterMessage) => void;
  adapters: readonly ChatAdapter[];
}

export type ExtensionConfig = {
  enabled: boolean;
  daemonHost: string;
  daemonPort: number;
  adapters: Record<string, boolean>;
};

export const DEFAULT_CONFIG: ExtensionConfig = {
  enabled: true,
  daemonHost: "127.0.0.1",
  daemonPort: 9147,
  adapters: {
    deepseek: true,
    qwen: true
  }
};
