# API Integration

How `apps/web` talks to backend services under `apps/api/<service>/`.

## Auth is a special case

The auth service has its own client SDK (`better-auth`). Use `authClient` from `$lib/auth/client.ts` — see `auth-flow.md`. Do NOT write a fetch wrapper for `apps/api/auth`. The rest of this rule applies to **non-auth** services (users, billing, etc.).

## The boundary

`apps/web` is a SvelteKit Worker. Backend services are independent Hono Workers. Communication is over public HTTP — service bindings are NOT used when cookies are involved (cookies don't round-trip across service-binding `fetch()`).

> Service bindings ARE fine when no cookies are involved (server → server data fetch with a service-issued bearer token).

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

In `+page.server.ts`, `+layout.server.ts`, `+server.ts`, hooks, and any server module called from one of those, use the `fetch` parameter from the SvelteKit event. SvelteKit's `event.fetch` runs through `handleFetch` (so cookie forwarding works) and integrates with caching / dedup.

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

## `handleFetch` — cookie forwarding for cross-origin services

`apps/web` and `apps/api/auth` are on different origins (e.g. `example.com` and `auth.example.com`). When the server-side `event.fetch` calls the upstream, SvelteKit's `handleFetch` hook is the only correct place to forward the user's cookie.

```typescript
// src/hooks.server.ts
import { PUBLIC_AUTH_URL } from '$env/static/public';

export const handleFetch: HandleFetch = async ({ request, fetch, event }) => {
	if (request.url.startsWith(PUBLIC_AUTH_URL)) {
		// Forward the inbound cookie (set by upstream auth) to the upstream so it
		// can resolve the session.
		request.headers.set('cookie', event.request.headers.get('cookie') ?? '');
	}
	return fetch(request);
};
```

Without this, the upstream sees no session cookie on server-rendered loads and returns 401 even though the user is logged in.

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
| Service binding when cookies are involved | Public HTTP fetch with `handleFetch` cookie forwarding |
| Inline a 40-line fetch in a route | One thin wrapper per service in `src/lib/api/` |
| Write a `lib/api/auth.ts` fetch wrapper | Use `authClient` from `$lib/auth/client` (better-auth's SDK) |
| `try/catch` to convert errors | `fromPromise` from `$lib/utils/result` |
