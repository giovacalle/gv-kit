# API Integration

How `apps/web` talks to backend services under `apps/api/<service>/`.

## Auth is a special case

The auth service has its own client SDK (`better-auth`). Use `authClient` from `$lib/auth/client.ts` — see `auth-flow.md`. Do NOT write a fetch wrapper for `apps/api/auth`. The rest of this rule applies to **non-auth** services (users, billing, etc.).

## The boundary

`apps/web` is a SvelteKit Worker. Backend services are independent Hono Workers. On Cloudflare, auth is exposed only through the web app's same-origin `/api/auth/*` façade, which forwards the original request through the `AUTH` Service Binding and returns the response unchanged. Non-auth services use the transport declared for that service; never expose an internal Worker merely to avoid a binding.

## Typed fetch wrapper

One file per upstream service, ~20–40 LOC each. Lives at `src/lib/api/<service>.ts`.

```typescript
// src/lib/api/users.ts
import { PUBLIC_USERS_URL } from '$env/static/public';

export async function usersFetch(
	path: string,
	init: RequestInit & { fetch?: typeof fetch } = {}
): Promise<Response> {
	const { fetch: f = fetch, ...rest } = init;
	return f(`${PUBLIC_USERS_URL}${path}`, {
		...rest,
		credentials: 'include',
		headers: {
			'content-type': 'application/json',
			...(rest.headers ?? {})
		}
	});
}
```

Request the typed JSON via a thin helper at the call site, not inside the wrapper — keep the wrapper transport-only.

## Use `event.fetch` on the server, NOT global `fetch`

In `+page.server.ts`, `+layout.server.ts`, `+server.ts`, hooks, and any server module called from one of those, use the `fetch` parameter from the SvelteKit event. SvelteKit's `event.fetch` integrates with same-origin routing, caching, and deduplication.

```typescript
// src/routes/users/+page.server.ts
import { usersFetch } from '$lib/api/users';

export const load = async ({ fetch, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const res = await usersFetch('/api/users/me', { fetch });
	if (!res.ok) throwAppError('INTERNAL_ERROR', 'Failed to load profile');
	return { profile: await res.json() };
};
```

The helper accepts `fetch` and forwards it. Never call the global `fetch` from server code.

## Same-origin auth façade

The browser and SSR code call `/api/auth/*` on the web origin. The catch-all SvelteKit endpoint forwards the request over the `AUTH` Service Binding. Preserve method, body, query, `Cookie`, `Origin`, and the response's `Set-Cookie`; do not reconstruct auth payloads or publish the auth Worker on another hostname.

## Session loading

Auth-specific: handled in `hooks.server.ts` by `$lib/server/load-session.ts`. See `auth-flow.md`. Don't write a parallel mechanism in `lib/api/`.

## Client-side data fetches

For SPA-style fetches AFTER hydration (live data, polling, mutations not via form actions), call the typed wrapper with the page's `fetch`:

```svelte
<script lang="ts">
	import { usersFetch } from '$lib/api/users';
	import { fromPromise } from '$lib/utils/result';

	async function refresh() {
		const r = await fromPromise(usersFetch('/api/users/me').then((res) => res.json()));
		if (r.isErr()) toast.error(r.error.message);
	}
</script>
```

Wrap the call in `Result<T, AppError>` (see `core-errors.md`). No `try/catch` for flow control.

## Anti-patterns

| Don't | Do |
|---|---|
| Call global `fetch(...)` in `+*.server.ts` | Use `event.fetch` and pass it through wrappers |
| Hardcode upstream URLs | Read from `$env/static/public` (`PUBLIC_*_URL`) |
| Public auth Worker hostname | Same-origin web façade over the `AUTH` Service Binding |
| Inline a 40-line fetch in a route | One thin wrapper per service in `src/lib/api/` |
| Write a `lib/api/auth.ts` fetch wrapper | Use `authClient` from `$lib/auth/client` (better-auth's SDK) |
| `try/catch` to convert errors | `fromPromise` from `$lib/utils/result` |
