# DeckAgent v2 Chrome Extension

Self-hosted MCP bridge browser extension. Intercepts web AI chat API calls and routes tool execution through the local DeckAgent daemon (`ws://127.0.0.1:9147/tunnel`).

## Structure

- `src/adapters/` — Chat adapters (DeepSeek, Qwen, Kimi, Z.ai) + shared tool extract/append helpers
- `src/lib/fetch-patch.ts` — MAIN-world `fetch` monkey-patch
- `src/lib/messages.ts` — Bridge message types between worlds / background
- `src/entrypoints/injected.content.ts` — MAIN world (patches page `fetch`)
- `src/entrypoints/content.ts` — Isolated world (forwards to background via `chrome.runtime`)
- `src/entrypoints/background.ts` — Service worker: daemon WS + tool execution loop
- `src/entrypoints/popup/` — Status UI (daemon connection, adapters, enable toggle)

## Scripts

```bash
npm install
npm run dev      # WXT dev mode
npm run build    # Production build → .output/chrome-mv3
npm run check    # TypeScript check
npm test         # Unit tests (no Chrome required)
```

## How it works

1. **MAIN world** patches `window.fetch` on supported chat origins and reports request/response via `window.postMessage`.
2. **Isolated world** listens for those messages and forwards them with `chrome.runtime.sendMessage`.
3. **Background** connects to the daemon WebSocket, forwards intercepts, and when `<<<TOOL>>>…<<<END>>>` calls are detected, sends `execute_tool` and waits for `tool_result` / `tool_error`.
4. Tool results are posted back to the page (overlay + queued for the next outbound chat request via `appendToolResult`).
