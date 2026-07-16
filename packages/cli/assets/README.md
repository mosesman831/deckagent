# DeckAgent CLI bundled assets

Populated by `npm run bundle:cli` (`scripts/bundle-cli-assets.mjs`) before publish (`prepack`).

| Path | Purpose |
|------|---------|
| `worker/` | Cloudflare Worker sources (`src/`, `wrangler.jsonc`, `package.json`, `tsconfig.json`) used when the monorepo sibling `packages/cloudflare-worker` is absent (e.g. `npx @deckagent/cli`) |

The desktop daemon is **not** copied here. `@deckagent/cli` depends on `@deckagent/desktop-daemon` and resolves its `dist` entry via `createRequire` / `import.meta.resolve`.

Do not hand-edit `worker/`; re-run `npm run bundle:cli` after changing the Worker package.
