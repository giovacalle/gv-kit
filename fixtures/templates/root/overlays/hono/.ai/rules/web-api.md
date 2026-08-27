# API integration

How `apps/web` uses the public gateway at `apps/api/`. Private services live under `services/` and are not web dependencies.

<!--@gvkit:if apiClientHeyApi-->
## One public client

Use the flat `@repo/openapi-client` package for domain API operations. It is generated from the composed gateway contract at `apps/api/openapi.json`. Do not create per-service client packages or fetch wrappers.

The browser client keeps an empty base URL, so requests at `/api` and `/api/*` use the web origin's same-origin gateway alias:

```typescript
// src/routes/+layout.ts
import { client } from '@repo/openapi-client';

client.setConfig({
	baseUrl: '',
	credentials: 'include'
});
```

Browser components import domain-prefixed operations from the package root.
<!--@gvkit:else-->
## Public contract without a generated client

The gateway still composes `apps/api/openapi.json`, but this workspace does not emit a generated API client package, client scripts, imports, or exports. Browser code calls same-origin `/api/*` paths directly. Do not configure a public URL for each private service.
<!--@gvkit:endif-->

## Server requests use the gateway transport

Use the request-scoped `fetch` from SvelteKit loads, actions, hooks, and server routes.
<!--@gvkit:if apiClientHeyApi-->
Pass it to the flat client with the incoming web origin:

```typescript
// src/routes/users/+page.server.ts
import { usersGetMe } from '@repo/openapi-client';

export const load = async ({ fetch, url }) => {
	const { data } = await usersGetMe({ baseUrl: url.origin, fetch });
	return { profile: data ?? null };
};
```
<!--@gvkit:else-->
Call the public gateway path with `event.fetch`. Do not add a service-specific client wrapper.
<!--@gvkit:endif-->

For same-origin `/api` and `/api/*` SSR requests, `handleFetch` in `hooks.server.ts` changes only the transport. It does not handle inbound browser requests. Cloudflare SSR calls the gateway through the `GATEWAY` Service Binding. Node and Docker SSR use the private `GATEWAY_URL`. Neither path calls auth or a domain service directly.

Preserve method, path, query, request headers, cookies, body streams, redirects, status, and response headers when changing this transport.

<!--@gvkit:if auth-->
## Auth uses Better Auth

Use the official Better Auth client, `authClient` from `$lib/auth/client.ts`, and keep its base URL unset. Browser auth calls use the same-origin `/api/auth/*` gateway alias. Session loading in `$lib/server/load-session.ts` uses `event.fetch`, so SSR follows the same private gateway transport as owned API requests.

Do not send owned API operations through Better Auth. Do not create an auth fetch wrapper or SvelteKit auth facade.
<!--@gvkit:endif-->

## Anti-patterns

| Don't | Do |
|---|---|
<!--@gvkit:if apiClientHeyApi-->
| Configure a browser URL per private service | Use the flat gateway client with `baseUrl: ''` |
| Add `src/lib/api/<service>.ts` wrappers | Import domain-prefixed operations from `@repo/openapi-client` |
| Call global `fetch` in `+*.server.ts` | Pass SvelteKit's request-scoped `fetch` to the flat client |
<!--@gvkit:else-->
| Configure a browser URL per private service | Call the same-origin gateway path |
| Add `src/lib/api/<service>.ts` wrappers | Use request-scoped `fetch` at the consuming boundary |
<!--@gvkit:endif-->
| Bind the web Worker to a private domain service | Bind web only to `GATEWAY` for SSR |
<!--@gvkit:if auth-->
| Write a `lib/api/auth.ts` wrapper | Use the official Better Auth client from `$lib/auth/client` |
<!--@gvkit:endif-->
| Add a SvelteKit `/api` or `/api/*` proxy | Keep browser ingress on the more-specific Cloudflare gateway routes |
