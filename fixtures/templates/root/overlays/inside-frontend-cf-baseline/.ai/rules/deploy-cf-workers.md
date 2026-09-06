# Cloudflare Workers

The SvelteKit application under `apps/web/` is the only Worker application in this topology. Server loads, actions, hooks, and `+server.ts` handlers run in that Worker.

## Configuration

`apps/web/wrangler.jsonc` is the source of truth for the Worker name, assets, compatibility settings, variables, secrets, and data resources. Keep the `App.Platform.env` declaration in `apps/web/src/app.d.ts` aligned with it.

Use `wrangler.jsonc`, never `wrangler.toml`.

## Data access

SvelteKit server handlers consume the resources declared by the web Worker. Database setup stays in `packages/db/`; handlers import it through `@repo/db`.

## Runtime constraints

- Use Web APIs in Worker code. Do not import `fs`, `path`, `node:crypto`, or `node:buffer`.
- Read runtime configuration from `platform.env`, not `process.env`.
- Use Web streams and Web Crypto.
- Run `pnpm typecheck`, `pnpm lint`, and `pnpm build` before deployment.
