# Svelte 5 + SvelteKit conventions

Runes-only Svelte 5, with the SvelteKit folder layout and load-function defaults that `apps/web/` follows. Legacy reactive syntax (`$:`, top-level `let` as reactive, `export let`) is forbidden.

## The rune set

```svelte
<script lang="ts">
	let count = $state(0);
	const doubled = $derived(count * 2);
	const expensive = $derived.by(() => heavyCompute(count));

	$effect(() => {
		document.title = `Count: ${count}`;
	});

	let { initial = 0 }: { initial?: number } = $props();
</script>
```

| Need | Use |
|---|---|
| Reactive scalar / object / array | `$state(...)` |
| Derived value (sync, cheap) | `$derived(expr)` |
| Derived value (multiple statements, expensive) | `$derived.by(() => ...)` |
| Side effect tied to reactive deps | `$effect(() => ...)` |
| Component props | `$props()` |
| Bindable prop | `$bindable()` |

`$:` is forbidden anywhere. So is `export let`. So is reading a non-rune `let` and expecting reactivity.

## `runed` — try it before writing a custom hook

[runed.dev](https://runed.dev) ships idiomatic Svelte 5 reactive utilities. Check it before reaching for `$effect`:

| Need | Use |
|---|---|
| Debounced value | `Debounced` |
| Throttled value | `Throttled` |
| Previous value | `Previous` |
| Element size | `ElementSize` |
| Media queries | `MediaQuery` |
| Local / session storage | `PersistedState` |
| Clipboard | `Clipboard` |
| Intersection observer | `IntersectionObserver` |
| Document visibility | `DocumentVisibility` |
| Async resource | `resource` |

```typescript
import { Debounced, MediaQuery, PersistedState } from 'runed';

let search = $state('');
const debouncedSearch = new Debounced(() => search, 300);
const isMobile = new MediaQuery('(max-width: 768px)');
const theme = new PersistedState('theme', 'light');
```

If `runed` already covers it, use it. Don't roll your own.

## Class-based contexts (MANDATORY)

Shared reactive state goes through Svelte's Context API with a class holder. **Never** export module-level `$state` from a `.svelte.ts` — it leaks across SSR requests and breaks Svelte 5's `state_referenced_locally` invariants.

<!--@gvkit:if auth-->
The pattern is: **client singleton** in `$lib/auth/client.ts` (stateless action helpers — `signIn`, `signUp`, `signOut`, plugin methods) plus a **class context** that mirrors the reactive session into `$state` fields. Components read the context for reactive state; they call the singleton directly for actions.

```typescript
// src/lib/auth/client.ts
<!--@gvkit:if hono-->
import { createAuthClient } from 'better-auth/svelte';

export const authClient = createAuthClient();
<!--@gvkit:else-->
import { PUBLIC_AUTH_URL } from '$env/static/public';
import { createAuthClient } from 'better-auth/svelte';

export const authClient = createAuthClient({ baseURL: PUBLIC_AUTH_URL });
<!--@gvkit:endif-->
export type Session = typeof authClient.$Infer.Session;
```

```typescript
// src/lib/context/auth-context.svelte.ts
import { getContext, setContext } from 'svelte';
import { goto } from '$app/navigation';
import type { BetterFetchError } from 'better-auth/svelte';

import { authClient, type Session } from '$lib/auth/client';

class AuthContext {
	session = $state<Session | null>(null);
	isLoading = $state<boolean>(false);
	error = $state<BetterFetchError | null>(null);

	signOut = async () => {
		await authClient.signOut();
		await goto('/');
	};

	#sessionStore = authClient.useSession();

	constructor() {
		$effect(() => {
			const unsubscribe = this.#sessionStore.subscribe(($s) => {
				this.session = $s.data;
				this.isLoading = $s.isPending || $s.isRefetching;
				this.error = $s.error;
			});
			return () => unsubscribe();
		});
	}
}

const KEY = Symbol('auth-context');

export const setAuthContext = (): AuthContext => setContext(KEY, new AuthContext());
export const getAuthContext = (): AuthContext => getContext<AuthContext>(KEY);
```

Set the context once in the root `+layout.svelte`. Read it downstream for reactive session state; call `authClient` directly for one-shot actions.

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
	import { setAuthContext } from '$lib/context/auth-context.svelte';
	setAuthContext();
</script>
```

```svelte
<!-- src/routes/me/+page.svelte -->
<script lang="ts">
	import { getAuthContext } from '$lib/context/auth-context.svelte';
	const auth = getAuthContext();
</script>

{#if auth.session}<p>signed in as {auth.session.user.email}</p>{/if}
```

```svelte
<!-- src/routes/login/+page.svelte — actions go through the singleton -->
<script lang="ts">
	import { authClient } from '$lib/auth/client';
	async function continueWithGoogle() {
		await authClient.signIn.social({ provider: 'google', callbackURL: '/me' });
	}
</script>
```
<!--@gvkit:endif-->

### Forbidden alternatives

| Don't | Why |
|---|---|
| `export const x = $state(...)` at module scope | Shared across SSR requests — leaks one user's data to another |
<!--@gvkit:if auth-->
| `getContext<X>('auth-context')` with a string key | No compile-time safety; trivially collides with another package using the same string |
| `export const auth = new AuthContext()` (singleton) | Same SSR leak as module-level `$state` |
<!--@gvkit:endif-->
| `class X` exported without `setX/getX` factories | Forces every consumer to import `setContext`/`getContext` directly and invent a key |

The `Symbol(...)` must live in the same file as the class — exporting it would let consumers bypass the factory.

## SSR module-state footgun

`$state` declared at module scope of a `.svelte.ts` is **server-shared**. Either move it inside a class (and instantiate via context) or load it per-request through `+layout.server.ts` and pass it down via `data`.

```typescript
// FORBIDDEN — leaks across SSR requests
export const currentUser = $state<User | null>(null);
```

```typescript
// SAFE — per-request via locals + load
// In +layout.server.ts:
export const load = ({ locals }) => ({ user: locals.user ?? null });
```

```typescript
// SAFE — exported FACTORY, instantiated per component:
export class FormState {
	value = $state('');
}
```

## `state_referenced_locally` warning

Fires when you capture a prop's value directly inside `$state(...)`. That snapshots the initial value and never updates.

```svelte
<!-- WRONG -->
<script>
	let { initialData } = $props();
	let name = $state(initialData?.name ?? ''); // state_referenced_locally
</script>
```

| Need | Use |
|---|---|
| Read-only display that should reflect prop changes | `const x = $derived(prop.value)` |
| Editable field seeded by prop | `let x = $state(''); $effect(() => { x = prop.value })` |
| Deep-nested seed (e.g. nested form) | `$derived.by(() => prop)` + `$effect` to copy into `$state` |

## Custom reactive primitives (hooks)

Before writing one, walk the flow. The first match wins:

1. **State that belongs to a context?** → method on the context class. Do NOT extract a hook around it.
2. **`runed` covers it?** → use `runed` directly. The library is the rule, not a starting point.
3. **Scoped to a single route or subtree?** → co-locate at `src/routes/<path>/_hooks/use-<name>.svelte.ts`.
4. **Cross-cutting, needed by 2+ routes?** → `src/lib/hooks/use-<name>.svelte.ts`.

Naming: `use-<kebab>.svelte.ts`. Lowercase, `use-` prefix, `.svelte.ts` extension. Same shape as a `runed` utility — class or factory function returning reactive accessors. No string `getContext` keys, no module-level `$state` exports.

```typescript
// src/lib/hooks/use-clipboard.svelte.ts
export function useClipboard() {
	let copied = $state(false);
	return {
		get copied() { return copied; },
		async copy(value: string) {
			await navigator.clipboard.writeText(value);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		}
	};
}
```

## Services vs API — two different layers

<!--@gvkit:if auth-->
Keep application API access separate from auth and third-party SDK integrations.
<!--@gvkit:else-->
Keep application API access separate from third-party SDK integrations.
<!--@gvkit:endif-->

<!--@gvkit:if hono-->
| Folder | What lives there | Examples |
|---|---|---|
<!--@gvkit:if apiClientHeyApi-->
| `packages/openapi-client/` | Flat generated client for the public gateway contract | `usersGetMe`, `usersGetMeOptions` |
<!--@gvkit:else-->
| `apps/api/openapi.json` | Composed public gateway contract | `/api/v1/*` domain routes |
<!--@gvkit:endif-->
<!--@gvkit:if auth-->
| `src/lib/auth/` | Better Auth `authClient` singleton. One file: `client.ts` | `auth/client.ts` |
<!--@gvkit:endif-->
| `src/lib/services/` | Wrappers around **third-party SDKs** with their own I/O surface (analytics, captcha, payments, transactional email) | `services/umami.ts`, `services/turnstile.ts`, `services/stripe.ts` |

<!--@gvkit:if apiClientHeyApi-->
Browser API calls use same-origin `/api/*` paths through the flat gateway client. Server loads and actions pass SvelteKit's request-scoped `fetch` to that same client.
<!--@gvkit:else-->
Browser API calls use same-origin `/api/*` paths directly. Server loads and actions call those paths with SvelteKit's request-scoped `fetch`.
<!--@gvkit:endif-->
On Cloudflare, `handleFetch` routes SSR calls through the web Worker's `GATEWAY` Service Binding. Never add a per-service public URL or a direct web-to-private-service binding.

<!--@gvkit:if auth-->
Auth uses the official Better Auth client. Use `authClient` from `$lib/auth/client`, never a raw auth fetch wrapper or the owned gateway API access path.
<!--@gvkit:endif-->
Third-party vendors live in `src/lib/services/`. One file per vendor; no per-vendor sub-folders until that vendor owns 5+ files.
<!--@gvkit:else-->
| Folder | What lives there | Examples |
|---|---|---|
| `src/lib/auth/` | Better-auth `authClient` singleton. One file: `client.ts` | `auth/client.ts` |
| `src/lib/services/` | Wrappers around **third-party SDKs** with their own I/O surface (analytics, captcha, payments, transactional email) | `services/umami.ts`, `services/turnstile.ts`, `services/stripe.ts` |

Auth has its own client SDK. Use `authClient` from `$lib/auth/client`, never a raw fetch wrapper. Third-party vendors live in `src/lib/services/`. One file per vendor; no per-vendor sub-folders until that vendor owns 5+ files.
<!--@gvkit:endif-->

## Types live next to their owners

No `src/lib/types/` folder. Types follow the code they describe.

| Type origin | Where it lives |
|---|---|
| Inferred from a zod schema | Alongside the schema in `src/lib/schemas/<domain>.ts` — `export type X = z.infer<typeof xSchema>` |
<!--@gvkit:if apiClientHeyApi-->
| API response DTO generated from the public gateway contract | `packages/openapi-client/` — don't redeclare in the app |
<!--@gvkit:endif-->
| Component prop shape | Inside the `.svelte` file's `<script>` as a local `type Props` |
| Cross-cutting, not derived from anything | `src/lib/types.ts` (single file) once 3+ types accumulate. Never a folder |

## Folder layout

```
apps/web/src/
├── app.css                     # imports @repo/ui/styles, nothing else of substance
├── app.d.ts                    # App.Locals / App.PageData / App.Platform / App.Error augmentation
├── app.html                    # root HTML template
<!--@gvkit:if auth-->
├── hooks.server.ts             # session bootstrap, handleFetch cookie forwarding
<!--@gvkit:else-->
├── hooks.server.ts             # request-scoped gateway transport
<!--@gvkit:endif-->
├── lib/
<!--@gvkit:if auth-->
│   ├── auth/                   # official Better Auth client only
<!--@gvkit:endif-->
│   ├── components/
│   │   ├── layout/             # chrome: nav, footer, header, sidebar
│   │   ├── seo.svelte          # <svelte:head> wrapper consumed by +layout.svelte
│   │   └── <name>.svelte       # other app-specific composites (flat)
│   ├── config/                 # static app config: site.ts (name, url, OG defaults)
│   ├── context/                # *-context.svelte.ts class holders (setX/getX + Symbol)
│   ├── hooks/                  # cross-route reactive primitives (use-*.svelte.ts)
│   ├── schemas/                # zod schemas shared by routes; types live alongside
│   ├── server/                 # SvelteKit-enforced server-only (errors, secrets, db wrappers)
│   ├── services/               # third-party SDK wrappers (umami, turnstile, …)
│   └── utils/                  # isomorphic helpers (result.ts, format.ts)
└── routes/
    ├── +error.svelte           # root fallback
<!--@gvkit:if auth-->
    ├── +layout.server.ts       # session loader
    ├── +layout.svelte          # root shell: setAuthContext + Seo + theme + toaster + nav + footer
<!--@gvkit:else-->
    ├── +layout.svelte          # root shell: Seo + theme + toaster + nav + footer
<!--@gvkit:endif-->
    ├── +page.svelte            # landing
    ├── sitemap.xml/+server.ts  # hand-rolled
    ├── robots.txt/+server.ts   # hand-rolled
    └── <segment>/
        ├── +page.server.ts     # canonical: load + actions
        ├── +page.svelte
        ├── +error.svelte       # segment-level error boundary
        ├── _components/        # page-private composites (underscore = not routed)
        └── _hooks/             # page-private reactive primitives (optional)
```

UI primitives live in `@repo/ui`, NOT under `apps/web/src/lib/components/ui/`. That path must not exist.

## Naming

- Components: `kebab-case.svelte` always. Example: `mode-toggle.svelte`, `locale-switcher.svelte`. Never `ModeToggle.svelte`.
- Routes follow SvelteKit conventions: `+page.svelte`, `+page.server.ts`, `+error.svelte`, `+layout.*`, `+server.ts`.
- Page-private composites: under `_components/` (the underscore keeps them out of routing).
<!--@gvkit:if auth-->
- Class state holders: `kebab-case.svelte.ts` (e.g. `auth-context.svelte.ts`).
<!--@gvkit:else-->
- Class state holders: `kebab-case.svelte.ts` (e.g. `feature-context.svelte.ts`).
<!--@gvkit:endif-->
- Reactive primitives: `use-<kebab>.svelte.ts` (e.g. `use-clipboard.svelte.ts`).

<!--@gvkit:if auth-->
## Route grouping — flat segments + segment-level guards

Default to flat segments. Use route groups (`(group)/`) only when two trees genuinely need different layouts. For auth gating, use a segment-level `+layout.server.ts` that runs the guard:

```typescript
// src/routes/me/+layout.server.ts
import { redirect } from '@sveltejs/kit';

export const load = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	return { user: locals.user };
};
```

Children of `me/` inherit `data.user` automatically. No `(authenticated)/` group needed.
<!--@gvkit:endif-->

## `+page.server.ts` vs `+page.ts` — defaults

| Need                                                          | File              | Why                                                |
| ------------------------------------------------------------- | ----------------- | -------------------------------------------------- |
<!--@gvkit:if auth-->
| Reading bindings (D1, KV, R2), env vars, session              | `+page.server.ts` | Server-only context                                |
<!--@gvkit:else-->
| Reading bindings (D1, KV, R2) or environment variables        | `+page.server.ts` | Server-only context                                |
<!--@gvkit:endif-->
| Form actions (mutations)                                      | `+page.server.ts` | Actions only run on the server                     |
<!--@gvkit:if auth-->
| Calling an upstream API with the user's cookie                | `+page.server.ts` | Uses `event.fetch` + `handleFetch` for forwarding  |
| Pure client computation, public data, no auth-gated branching | `+page.ts`        | Lighter — runs on both server (SSR) and client     |
<!--@gvkit:else-->
| Calling an upstream API with request-scoped transport         | `+page.server.ts` | Uses `event.fetch` + `handleFetch` for forwarding  |
| Pure client computation with public data                      | `+page.ts`        | Lighter — runs on both server (SSR) and client     |
<!--@gvkit:endif-->
| Real-time WebSocket pages                                     | `+page.svelte` only | Hydrate, then connect. Server load may still seed metadata |

**Default: `+page.server.ts`.** Reach for `+page.ts` only when there's a clear bundle-size or cache-locality win.

## `+error.svelte` per route group

<!--@gvkit:if auth-->
Add a sibling `+error.svelte` whenever a segment has its own UX expectations (auth pages, dashboard, marketing). SvelteKit walks up the tree to find the nearest one. The root `src/routes/+error.svelte` is the catch-all fallback.
<!--@gvkit:else-->
Add a sibling `+error.svelte` whenever a segment has its own UX expectations (dashboard, marketing). SvelteKit walks up the tree to find the nearest one. The root `src/routes/+error.svelte` is the catch-all fallback.
<!--@gvkit:endif-->

```svelte
<!-- src/routes/me/+error.svelte -->
<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.error?.message ?? 'Something went wrong'}</title>
</svelte:head>

<main class="mx-auto max-w-2xl px-4 py-16">
	<h1 class="text-2xl font-semibold">{page.error?.message ?? 'Something went wrong'}</h1>
	<p class="text-muted-foreground mt-2">Status {page.status}</p>
</main>
```

## `<svelte:head>` — managed via `<Seo />`, per page

The root `+layout.svelte` renders `<Seo />` once. The component is self-contained: it reads `siteConfig` and `page.url` to build the base tags. Per-page overrides land via a `+page.svelte` rendering its own `<svelte:head>` for one-off tags. See `web-seo.md` for the full pattern.

Inline `<svelte:head>` blocks are still fine for one-off needs (a specific `<script>` tag, a page-only `<link>`), but the baseline title/description/canonical/OG/Twitter set comes from the root `<Seo />`.

## Page layout shape

Every page wraps content in `<main class="mx-auto max-w-Nxl px-4 py-10 sm:py-16">` and follows:

1. Optional back button (for create/edit / detail pages) above the header.
2. `<header>` with `h1` + muted `p` description.
3. Content.

Don't render a per-page title bar in the layout — every page renders its own header.

## Anti-patterns

| Don't | Do |
|---|---|
| `let count = 0; $: doubled = count * 2;` | `let count = $state(0); const doubled = $derived(count * 2);` |
| `export let foo` | `let { foo } = $props()` |
| `export const x = $state(...)` at module scope | Class + `setX/getX` + `Symbol` (see Class-based contexts) |
| `getContext<X>('some-string')` with a string key | `Symbol(...)` in the same file as the class |
<!--@gvkit:if auth-->
| `export const auth = new AuthClient()` singleton | `setAuthContext()` in root layout, `getAuthContext()` downstream |
<!--@gvkit:endif-->
| Custom `useDebounce` hook | `new Debounced(...)` from `runed` |
| `let name = $state(initial.name)` from a prop | `const name = $derived(initial.name)` or `$effect` re-seed |
| `apps/web/src/lib/components/ui/<primitive>/` | Import from `@repo/ui/primitives/<name>` |
| `apps/web/src/lib/state/` | `lib/data/` for content fixtures, `lib/context/` for shared reactive state |
| `apps/web/src/lib/monitoring/` | `lib/services/` (umami, posthog, … sit alongside other vendor wrappers) |
| `apps/web/src/lib/types/` folder | Types alongside owners: schemas, components, or single `lib/types.ts` |
| `apps/web/src/lib/features/<feature>/` | Co-locate in `routes/<feature>/` — SvelteKit's route tree already is the feature boundary |
<!--@gvkit:if hono-->
| `apps/web/src/lib/domain/<entity>/` | Put reusable application logic in `packages/backend/`; invoke it from the transport adapter under `services/<service>/` |
<!--@gvkit:if apiClientHeyApi-->
| `apps/web/src/lib/api/<service>.ts` | Import domain-prefixed operations from the flat `@repo/openapi-client` package |
<!--@gvkit:else-->
| `apps/web/src/lib/api/<service>.ts` | Call the public gateway path with request-scoped `fetch` at the consuming boundary |
<!--@gvkit:endif-->
<!--@gvkit:else-->
| `apps/web/src/lib/domain/<entity>/` | Domain logic belongs behind a SvelteKit server boundary; this is client code |
<!--@gvkit:endif-->
| `apps/web/src/lib/stores/` | `.svelte.ts` class holders in `lib/context/`. Runes replace stores |
| `+layout.svelte` setting `<title>` once for the whole app | Per-page `<svelte:head>` overrides on top of root `<Seo />` |
<!--@gvkit:if auth-->
| Route group `(authenticated)/` for a single guard | Segment-level `+layout.server.ts` with `redirect()` |
| `+page.ts` for a route that reads `locals.user` | `+page.server.ts` (locals is server-only) |
<!--@gvkit:endif-->
| PascalCase component filenames | `kebab-case.svelte` |
