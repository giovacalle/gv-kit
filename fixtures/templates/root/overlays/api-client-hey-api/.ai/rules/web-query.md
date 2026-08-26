# Client data — TanStack Query (svelte-query)

The flat generated client (`@repo/openapi-client`) ships both plain SDK
functions and TanStack Query options. Domain-prefixed operation IDs keep root exports unique.

## The split — server-first stays server-first

| Need                                          | Use                                  | Where                     |
| --------------------------------------------- | ------------------------------------ | ------------------------- |
| Auth-gated initial data, SSR                  | plain SDK fn + `event.fetch`         | `+page.server.ts` load    |
| Mutations (writes)                            | `superForms` + form actions          | `+page.server.ts` actions |
| Auth (session, sign-in/out)                   | `authClient` (better-auth)           | client                    |
| Live client reads (polling, infinite, search) | `createQuery` + generated `*Options` | `+page.svelte`            |

TanStack Query is **only** for client-side reads on non-auth services. It does
NOT replace load functions, form actions, or the auth client.

## Server load — plain SDK function

```ts
// +page.server.ts
import { usersGetMe } from '@repo/openapi-client'

export const load = async ({ fetch, url }) => {
	const { data } = await usersGetMe({ baseUrl: url.origin, fetch }) // event.fetch routes same-origin API calls privately
	return { profile: data }
}
```

## Client read — query options

```svelte
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query'
	import { usersGetMeOptions } from '@repo/openapi-client'

	const profile = createQuery(() => usersGetMeOptions())
</script>
```

Wrap option args in a function — `createQuery(() => options)` — so reactive
inputs (a search term, filters, an id) re-run the query. Access results
directly with runes, no `$`: `profile.data`, `profile.isPending`,
`profile.isError`. For paginated endpoints the generator also emits
`<op>InfiniteOptions` for `createInfiniteQuery`.

## The QueryClient is per-request

Created in the root `+layout.ts` load and provided via `<QueryClientProvider>`.
NEVER instantiate it at module scope of a `.svelte`/`.ts` file — a shared client
leaks cache across SSR requests. Per-request creation is the only safe form.

```ts
// src/routes/+layout.ts
import { browser } from '$app/environment'
import { QueryClient } from '@tanstack/svelte-query'

export const load = ({ data }) => ({
	...data,
	queryClient: new QueryClient({ defaultOptions: { queries: { enabled: browser } } })
})
```

Spread `...data` so server-load values (session, locale) survive the universal
load. `enabled: browser` keeps queries from running during SSR — when you need
data in the initial HTML, pair a server `load` with the plain SDK function.

## Mutations stay on form actions

Do not introduce `createMutation` for a write that a form action already covers.
Writes go through `superForms` + `+page.server.ts` actions (progressive
enhancement, server-side validation). Reach for `createMutation` only for
genuinely client-only, non-form interactions.

## Anti-patterns

| Don't                                            | Do                                          |
| ------------------------------------------------ | ------------------------------------------- |
| `createQuery` for auth-gated first paint         | `+page.server.ts` load + plain SDK fn       |
| `createMutation` for a form submit               | `superForms` + form action                  |
| `new QueryClient()` at module scope              | per-request in `+layout.ts` load            |
| Query the auth service via the generated client  | `authClient` from `$lib/auth/client`        |
| `createQuery(usersGetMeOptions())` (no fn)       | `createQuery(() => usersGetMeOptions())`    |
