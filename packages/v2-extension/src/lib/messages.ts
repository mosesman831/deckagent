import type { AdapterMessage, ToolCall } from "../adapters/types.js";

/** Window.postMessage envelope from MAIN-world fetch patch. */
export const MAIN_WORLD_SOURCE = "deckagent-v2-content-script";

/** Window.postMessage envelope from isolated bridge / background → page. */
export const BRIDGE_SOURCE = "deckagent-v2-bridge";

export type BridgeInbound = {
  source: typeof MAIN_WORLD_SOURCE;
  message: AdapterMessage;
};

export type BridgeOutbound =
  | {
      source: typeof BRIDGE_SOURCE;
      type: "tool_result";
      requestId: string;
      adapterType: string;
      results: Array<{
        name: string;
        args: Record<string, unknown>;
        ok: boolean;
        content?: string;
        error?: string;
      }>;
    }
  | {
      source: typeof BRIDGE_SOURCE;
      type: "daemon_status";
      connected: boolean;
    };

export type RuntimeMessage =
  | {
      type: "adapter_message";
      message: AdapterMessage;
    }
  | {
      type: "tool_calls";
      requestId: string;
      adapterType: string;
      requestBody: string;
      toolCalls: ToolCall[];
      tabId?: number;
    }
  | {
      type: "get_status";
    }
  | {
      type: "set_enabled";
      enabled: boolean;
    }
  | {
      type: "ping";
    };

export type StatusResponse = {
  enabled: boolean;
  daemonConnected: boolean;
  daemonUrl: string;
  adapters: Array<{ name: string; enabled: boolean }>;
};

export function isBridgeInbound(data: unknown): data is BridgeInbound {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return obj.source === MAIN_WORLD_SOURCE && obj.message !== null && typeof obj.message === "object";
}
