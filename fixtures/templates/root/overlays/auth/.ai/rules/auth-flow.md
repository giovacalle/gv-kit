# Auth Flow

Passwordless only — email-OTP and/or Google. There is no password field, no `/register`, no `/forgot-password`, no password reset.

## Client — singleton + reactive context

Two files, two responsibilities:

- **`src/lib/auth/client.ts`** — stateless `authClient` singleton (`signIn`, `signUp`, `signOut`, plugin methods). Used directly for one-shot actions.
- **`src/lib/context/auth-context.svelte.ts`** — class context that mirrors `authClient.useSession()` into reactive `$state` fields (`session`, `isLoading`, `error`). Used for reactive reads anywhere in the tree.

```typescript
// src/lib/auth/client.ts
import { PUBLIC_AUTH_URL } from '$env/static/public'
import { emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/svelte'

export const authClient = createAuthClient({
	baseURL: PUBLIC_AUTH_URL,
	plugins: [emailOTPClient()]
})

export type Session = typeof authClient.$Infer.Session
```

```typescript
// src/lib/context/auth-context.svelte.ts
import { getContext, setContext } from 'svelte'
import { goto } from '$app/navigation'
import type { BetterFetchError } from 'better-auth/svelte'

import { authClient, type Session } from '$lib/auth/client'

class AuthContext {
	session = $state<Session | null>(null)
	isLoading = $state<boolean>(false)
	error = $state<BetterFetchError | null>(null)

	signOut = async () => {
		await authClient.signOut()
		await goto('/')
	}

	#sessionStore = authClient.useSession()

	constructor() {
		$effect(() => {
			const unsubscribe = this.#sessionStore.subscribe(($s) => {
				this.session = $s.data
				this.isLoading = $s.isPending || $s.isRefetching
				this.error = $s.error
			})
			return () => unsubscribe()
		})
	}
}

const KEY = Symbol('auth-context')

export const setAuthContext = (): AuthContext => setContext(KEY, new AuthContext())
export const getAuthContext = (): AuthContext => getContext<AuthContext>(KEY)
```

The server gate at `me/+layout.server.ts` is the source of truth on first paint (it redirects when `locals.user` is empty). The client context takes over for live updates after hydration.

## Login wizard

Single page, single `<form>`, single `superForm` instance. Schema is `z.discriminatedUnion('step', ['send', 'verify'])`. The form is **client-only** (`SPA: true`): there are no server actions on `/login`. Submission flows through `onUpdate`, which calls `authClient.emailOtp.sendVerificationOtp` (step 1) or `authClient.signIn.emailOtp` (step 2), then either flips `$formData.step` or `goto('/me')`.

```ts
const sf = superForm(data.form, {
	validators: zodClient(loginWizardSchema),
	SPA: true,
	resetForm: false,
	onUpdate: async ({ form }) => {
		if (!form.valid) return
		if (form.data.step === 'send') {
			const res = await authClient.emailOtp.sendVerificationOtp({
				email: form.data.email,
				type: 'sign-in',
				fetchOptions: { headers: { 'x-captcha-response': form.data.turnstileToken } }
			})
			if (res.error) { /* setError / toast */ return }
			$formData = { step: 'verify', email: form.data.email, code: '' }
			return
		}
		const res = await authClient.signIn.emailOtp({ email: form.data.email, otp: form.data.code })
		if (res.error) { /* setError on 'code' */ return }
		await goto('/me')
	}
})
```

Branch-only fields (`code`, `turnstileToken`) bind through `fieldProxy(superform, 'fieldName')`.

## OTP UI

Use `@repo/ui/primitives/input-otp` with `REGEXP_ONLY_DIGITS`, `maxlength=6`, two `InputOTP.Group`s of 3 cells split by `InputOTP.Separator`. Autofocus, paste-aware.

## Turnstile

Cloudflare Turnstile widget on step 1 only. Rendered via [`@svelte-put/cloudflare-turnstile`](https://www.npmjs.com/package/@svelte-put/cloudflare-turnstile) — a Svelte 5 native, action-based wrapper that handles script loading, mounting, and teardown internally.

```ts
// devDependencies in apps/web/package.json
"@svelte-put/cloudflare-turnstile": "^<version>"
```

Use the `turnstile` action on a `<div>` and read callbacks via the action's events:

```svelte
<script lang="ts">
	import { turnstile } from '@svelte-put/cloudflare-turnstile'

	let token = $state('')
</script>

<div
	use:turnstile={{ sitekey: data.turnstileSiteKey, theme: 'auto' }}
	onturnstile={(e) => (token = e.detail.token)}
	onturnstileexpired={() => (token = '')}
	onturnstileerror={() => (token = '')}
></div>
```

No manual `script` injection, no `$effect`-based widget render/remove dance, no `window.turnstile.*` calls — the library owns the lifecycle.

### Token forwarding

The token is forwarded to the auth service via the `x-captcha-response` header inside `fetchOptions` of the `authClient` call:

```ts
await authClient.emailOtp.sendVerificationOtp({
	email: form.data.email,
	type: 'sign-in',
	fetchOptions: { headers: { 'x-captcha-response': form.data.turnstileToken } }
})
```

The auth Worker's `captcha` plugin (better-auth) verifies server-side — `apps/web` never holds the Turnstile secret.

Schema enforces `turnstileToken: z.string().min(1)` so a scripted submit without a token is rejected before any business logic runs.

### Server-side validation

The auth Worker enables better-auth's `captcha` plugin with `provider: 'cloudflare-turnstile'`. It intercepts the `/email-otp/send-verification-otp` endpoint, reads the `x-captcha-response` header, and validates against Cloudflare's siteverify. No manual siteverify code lives in the Worker.

Required environment variable in the auth Worker:
- `TURNSTILE_SECRET_KEY` (server-side only — never in `apps/web`)

The web Worker only holds `PUBLIC_TURNSTILE_SITE_KEY` (public, used to render the widget).

### Resetting the widget

When the user goes back from "verify" to "send" via "use a different email", or when the captcha-bound submit returns an error and the user should retry, the widget needs a fresh token. Two options, both fine:

- Wrap the widget in `{#key someKey}…{/key}` and bump `someKey` — Svelte destroys and recreates the action, which gets a new token automatically.
- Use the library's exposed reset API (per its docs) inside an error handler or transition callback.

Check `src/routes/login/+page.svelte` for the exact convention used in this repo and follow it.

## OAuth (Google)

Client-side trigger via the singleton (not the context):

```ts
import { authClient } from '$lib/auth/client'
await authClient.signIn.social({ provider: 'google', callbackURL: '/me' })
```

The auth Worker handles the round-trip via Google Cloud Console's redirect URI (`${AUTH_URL}/api/auth/callback/google`). The web app only needs to know the success destination.

## Account mutations (update / delete)

`me/account/+page.svelte` uses the same SPA pattern: superforms validates client-side, `onUpdate` calls `authClient.updateUser({ name })`. Delete-account is a plain `onclick` calling `authClient.deleteUser()` — no server action.

## Server-side session loading

`src/lib/server/load-session.ts` calls the same-origin `/api/auth/get-session` façade with `event.fetch` and populates `event.locals.user`. On Cloudflare, the façade forwards the original request through the `AUTH` Service Binding and returns the auth Worker's response unchanged, including `Set-Cookie`. The browser therefore stores a host-only cookie for the web origin and sends it on SSR requests.

This is the **only** server-side auth call. All mutations go through `authClient` from the browser.

## Anti-patterns

| Don't | Do |
|---|---|
| Add password fields, `/register`, `/forgot-password` | Passwordless only — email-OTP + Google |
| Point `PUBLIC_AUTH_URL` at a public auth subdomain | Point it at the web origin; `/api/auth/*` is the same-origin façade |
| Hardcode `PUBLIC_AUTH_URL` or the Turnstile site key | Read both from `$env/static/public` |
| Verify Turnstile in `apps/web` | Forward via `x-captcha-response`; the auth Worker verifies |
| Two separate `<form>`s for send + verify | Single `<form>`, single `superForm`, discriminated union schema |
| Skip the SSR session gate | `me/+layout.server.ts` redirects to `/login` when no session |
| `export const authClient = createAuthClient(...)` at module scope of a `.svelte.ts` | Singleton in plain `client.ts`, reactive mirror in the `.svelte.ts` context |
| Server actions for OTP send/verify, update-user, delete-user | Call `authClient.*` directly from the browser; the auth Worker is the source of truth |
| `event.fetch('${AUTH_URL}/api/auth/...')` from a route | Use `authClient` (browser) or `$lib/server/load-session.ts` (server session load only) |
