# Cloudflare Workers

The web app runs on Cloudflare Workers via `@sveltejs/adapter-cloudflare`. Server code (loads, actions, hooks, `+server.ts`) executes inside the Worker runtime — Node.js APIs are not available.

## Config — `wrangler.jsonc`, NEVER `.toml`

The single source of Worker config is `wrangler.jsonc` (JSONC: JSON with `//` comments and a `$schema` reference for editor IntelliSense).

```jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "__PROJECT__-web",
	"main": ".svelte-kit/cloudflare/_worker.js",
	"compatibility_date": "__COMPAT_DATE__",
	"compatibility_flags": ["nodejs_compat"],
	"assets": {
		"binding": "ASSETS",
		"directory": ".svelte-kit/cloudflare"
	}
}
```

`wrangler.toml` is FORBIDDEN. If you find a `.toml` Wrangler config, convert it.

### `nodejs_compat` flag

The `nodejs_compat` compatibility flag provides the Node.js compatibility APIs required by the generated SvelteKit application and its dependencies. Don't remove it.

## Bindings

Bindings (D1, KV, R2, Durable Objects, queues, secrets) are declared in `wrangler.jsonc` and surface on `platform.env` inside SvelteKit server contexts.

```typescript
// +page.server.ts
export const load = async ({ platform }) => {
	const db = platform!.env.MY_DB;             // D1Database
	const kv = platform!.env.MY_KV;             // KVNamespace
	const bucket = platform!.env.MY_BUCKET;     // R2Bucket
	// ...
};
```

> The web Worker owns static assets and the `GATEWAY` Service Binding for SSR. It does not bind directly to auth, users, databases, KV, R2, queues, or Durable Objects. The gateway at `apps/api/wrangler.jsonc` binds to private services, and each private service owns its data capabilities under `services/<service>/wrangler.jsonc`.

Browser `/api/*` traffic uses the web origin's more-specific Cloudflare route and reaches the gateway without invoking the web Worker. Server-side SvelteKit requests use `event.fetch`; `handleFetch` forwards same-origin API requests through `platform.env.GATEWAY`.

<!--@gvkit:if hono-->
The canonical API Custom Domain reaches the same gateway. Private services must have no `routes`, `workers_dev` must stay `false`, and `preview_urls` must stay `false`. Gateway-to-service and service-to-service calls use explicit Service Bindings. Never call a public gateway URL for internal work, and never import or mount a service application in the gateway.

Deploy database migrations first, then private services, gateway, and web. A Service Binding target must exist before its caller's first deployment. Preview bindings must target services with the same preview alias, never production services.

Credentialed CORS on the canonical API origin uses an explicit allowlist. `Access-Control-Allow-Origin: *` with credentials is forbidden.
<!--@gvkit:endif-->

## Typing — `App.Platform.env`

Fresh Hono workspaces include `worker-configuration.bootstrap.d.ts`, a binding baseline derived from `wrangler.jsonc` that lets clean typecheck and build commands run without rewriting source files. It does not occupy Wrangler's default output path or claim Wrangler ownership. Never hand-write the `Env` interface.

Run the package script after generation and whenever `wrangler.jsonc` changes:

```bash
pnpm cf-typegen
```

The script lets Wrangler create `worker-configuration.d.ts`, then removes the bootstrap. Commit Wrangler's generated replacement. Later runs regenerate that default file normally. `pnpm typecheck` validates the current declaration without mutating it.

`app.d.ts` augments `App.Platform`:

```typescript
// src/app.d.ts
declare global {
	namespace App {
		interface Platform {
			env: Env;
			cf: CfProperties;
			ctx: ExecutionContext;
		}
	}
}
export {};
```

`Env` comes from the clean-install bootstrap or Wrangler's generated `worker-configuration.d.ts`. Don't redefine it elsewhere.

## Forbidden Node.js APIs

The Worker runtime is V8 + a curated set of Web APIs. Node.js modules don't ship.

| Forbidden | Use |
|---|---|
| `import fs from 'fs'` / `'node:fs'` | Bundle assets into the Worker, or read from R2 / KV |
| `import path from 'path'` / `'node:path'` | URL APIs, manual string splits, or compile-time constants |
| `import crypto from 'node:crypto'` | `crypto.subtle` (Web Crypto, globally available) |
| `import { Buffer } from 'node:buffer'` | `atob`, `btoa`, `TextEncoder`, `TextDecoder` |
| `process.env.X` | `platform.env.X` (SvelteKit) or `env.X` (DO / cron) |
| `process.cwd()`, `process.exit()` | Doesn't exist on Workers — restructure |
| Long-lived timers that outlive a request | Use Durable Objects with alarms, or Cron Triggers |
| Node streams (`stream`) | Web streams (`ReadableStream`, `WritableStream`) |

If a dependency drags in `node:*`, check whether the package has a Workers-compatible export. If not, find a replacement — patching with polyfills is brittle.

## Web Crypto patterns

```typescript
// Random bytes
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);

// Random UUID (works in Workers)
const id = crypto.randomUUID();

// Hashing
const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello'));
const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
```

## Anti-patterns

| Don't | Do |
|---|---|
| `wrangler.toml` | `wrangler.jsonc` (with `$schema`) |
| A per-service public URL in web code | The same-origin gateway alias in browsers and `GATEWAY` binding for SSR |
| Hand-write `interface Env { ... }` | Run `wrangler types`, import from generated file |
| `import { randomBytes } from 'node:crypto'` | `crypto.getRandomValues(new Uint8Array(N))` |
| `import { Buffer } from 'node:buffer'` | `TextEncoder` / `TextDecoder` / `atob` / `btoa` |
| `setInterval` for periodic work | Cron Triggers, or Durable Object alarms |
| Long-running `await` after the response is sent | `event.platform.ctx.waitUntil(promise)` |
