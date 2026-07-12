# DeckAgent 🚀

**Self-host MCP bridge that gives web AI (ChatGPT, Claude, Gemini) hands on your computer.**

Deploy your own Cloudflare Worker, run a desktop daemon, and connect any web AI to your real filesystem, terminal, and browser -- fully self-hosted, no middleman.

## The Problem

ChatGPT and Claude web can now connect to custom MCP servers. But existing solutions:
- Route through **third-party relays** (your data goes through someone else's servers)
- Require **paid subscriptions** for remote access
- Don't support **computer-use** (screen, mouse, keyboard)
- Lock you into **someone else's infra**

## The Solution

**DeckAgent** is a self-hosted MCP bridge. You deploy a Cloudflare Worker (your domain, your infra), install a desktop daemon, and paste the URL into ChatGPT/Claude. Your web AI now has hands on your actual computer.

```
ChatGPT/Claude Web
    ↓  HTTPS + OAuth
Your Cloudflare Worker  ←  you control this
    ↓  WebSocket tunnel
Desktop Daemon  ←  system tray app
    ↓
Filesystem · Terminal · Browser · (soon: computer-use)
```

## Quick Start (once built)

```bash
npx deckagent setup
```

## Architecture

See [SPEC.md](SPEC.md) for full architecture, tool list, and data flow.

## License

MIT
