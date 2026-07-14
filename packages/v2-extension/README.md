# DeckAgent v2 Chrome Extension

Self-hosted MCP bridge browser extension.

## Structure

- `src/adapters/` — Chat adapter interface and built-in adapters (DeepSeek, Qwen).
- `src/content-scripts/` — Fetch monkey-patch injected into supported chat pages.
- `src/background.ts` — Service worker maintaining WebSocket connection to the local daemon.
- `src/popup.html` / `src/popup.ts` — Extension popup.
- `public/manifest.json` — Static Chrome extension manifest v3.
- `wxt.config.ts` — WXT build configuration.

## Scripts

```bash
npm install
npm run dev      # WXT dev mode
npm run build    # Production build
npm run check    # TypeScript check
```

## How it works

1. The content script installs a `fetch` monkey-patch on supported chat origins.
2. Matched requests/responses are wrapped as `AdapterMessage` and reported to the background worker.
3. The background worker forwards messages over a WebSocket (`ws://127.0.0.1:9147/tunnel`) to the DeckAgent desktop daemon.
4. The daemon executes tools and returns JSON-RPC-line-delimited responses.
