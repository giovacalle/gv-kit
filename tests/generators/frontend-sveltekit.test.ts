import { describe, expect, test } from 'bun:test'
import { generateFrontendSveltekit } from '../../src/generators/frontend-sveltekit.js'
import type { FileEntry } from '../../src/lib/files.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

type Auth = Choices['auth']

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'inside-web',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'sqlite',
	apiClient: 'hey-api',
	auth: [],
	email: 'skip',
	aiTooling: ['claude'],
	deploy: 'cf-workers'
}

function makeCfg(overrides: Partial<Choices>): GvKitConfig {
	return {
		configVersion: 2,
		choices: { ...baseChoices, ...overrides }
	}
}

function findEntry(entries: FileEntry[], path: string): FileEntry | undefined {
	return entries.find((e) => e.path === path)
}

const AUTH_VARIANTS: Auth[] = [[], ['emailOTP'], ['google'], ['emailOTP', 'google']]

describe('generateFrontendSveltekit — auth inclusion / exclusion', () => {
	test('auth=[] → login + me routes are absent', () => {
		const entries = generateFrontendSveltekit(makeCfg({ auth: [], email: 'skip' }))
		expect(findEntry(entries, 'apps/web/src/routes/login/+page.svelte')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/routes/login/+page.server.ts')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/routes/me/+layout.server.ts')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/routes/me/+page.svelte')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/routes/me/account/+page.svelte')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/lib/context/auth-context.svelte.ts')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/lib/auth/client.ts')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/lib/schemas/auth.ts')).toBeUndefined()
	})

	test.each<[Auth]>([[['emailOTP']], [['google']], [['emailOTP', 'google']]])(
		'auth=%j → login + me routes are present',
		(auth) => {
			const entries = generateFrontendSveltekit(makeCfg({ auth, email: 'resend' }))
			expect(findEntry(entries, 'apps/web/src/routes/login/+page.svelte')).toBeDefined()
			expect(findEntry(entries, 'apps/web/src/routes/login/+page.server.ts')).toBeDefined()
			expect(findEntry(entries, 'apps/web/src/routes/me/+layout.server.ts')).toBeDefined()
			expect(findEntry(entries, 'apps/web/src/routes/me/+page.svelte')).toBeDefined()
			expect(findEntry(entries, 'apps/web/src/routes/me/account/+page.svelte')).toBeDefined()
			expect(findEntry(entries, 'apps/web/src/lib/context/auth-context.svelte.ts')).toBeDefined()
			expect(findEntry(entries, 'apps/web/src/lib/auth/client.ts')).toBeDefined()
			expect(findEntry(entries, 'apps/web/src/lib/schemas/auth.ts')).toBeDefined()
		}
	)

	test('auth/client.ts wires better-auth/svelte; auth-context wraps the session store', () => {
		const entries = generateFrontendSveltekit(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		const client = findEntry(entries, 'apps/web/src/lib/auth/client.ts')!
		expect(client.content).toContain('better-auth/svelte')
		expect(client.content).toContain('createAuthClient')
		const context = findEntry(entries, 'apps/web/src/lib/context/auth-context.svelte.ts')!
		expect(context.content).toContain("from '$lib/auth/client'")
		expect(context.content).toContain('useSession()')
		expect(context.content).toContain('$state')
	})

	test('login page contains superForm + InputOTP + Turnstile widget code when emailOTP is on', () => {
		const entries = generateFrontendSveltekit(
			makeCfg({ auth: ['emailOTP', 'google'], email: 'resend' })
		)
		const login = findEntry(entries, 'apps/web/src/routes/login/+page.svelte')!
		expect(login.content).toContain('superForm')
		expect(login.content).toContain('InputOTP')
		expect(login.content).toContain('turnstile')
		const load = findEntry(entries, 'apps/web/src/routes/login/+page.server.ts')!
		expect(load.content).toContain(
			"import { PUBLIC_TURNSTILE_SITE_KEY } from '$env/static/public'"
		)
		expect(load.content).not.toContain('platform?.env')
	})

	test('login page renders Google CTA only when authGoogle is on', () => {
		const withGoogle = generateFrontendSveltekit(
			makeCfg({ auth: ['emailOTP', 'google'], email: 'resend' })
		)
		const withoutGoogle = generateFrontendSveltekit(
			makeCfg({ auth: ['emailOTP'], email: 'resend' })
		)
		const loginGoogle = findEntry(withGoogle, 'apps/web/src/routes/login/+page.svelte')!
		const loginNoGoogle = findEntry(withoutGoogle, 'apps/web/src/routes/login/+page.svelte')!
		expect(loginGoogle.content).toContain('Continue with Google')
		expect(loginGoogle.content).toContain('continueWithGoogle')
		expect(loginNoGoogle.content).not.toContain('Continue with Google')
		expect(loginNoGoogle.content).not.toContain('continueWithGoogle')
	})

	test('Astro Google-only login omits email OTP imports and state', () => {
		const entries = generateFrontendSveltekit(
			makeCfg({ marketing: 'astro', auth: ['google'], email: 'notifuse', deploy: 'docker' })
		)
		const login = findEntry(entries, 'apps/web/src/routes/login/+page.svelte')!.content

		for (const emailOnlySymbol of [
			'Loader2Icon',
			'@repo/ui/primitives/form',
			"@repo/ui/primitives/input'",
			'toast',
			'fieldProxy',
			'setError',
			"from '$app/navigation'",
			'errors',
			'submitting',
			'turnstileTokenProxy'
		]) {
			expect(login).not.toContain(emailOnlySymbol)
		}
		expect(login).toContain('continueWithGoogle')
	})

	test('passwordless-only routes are NEVER emitted (no register / forgot-password / logout)', () => {
		for (const auth of AUTH_VARIANTS) {
			const email = auth.length > 0 ? 'resend' : 'skip'
			const entries = generateFrontendSveltekit(makeCfg({ auth, email }))
			const paths = entries.map((e) => e.path)
			expect(paths).not.toContain('apps/web/src/routes/register/+page.svelte')
			expect(paths).not.toContain('apps/web/src/routes/forgot-password/+page.svelte')
			expect(paths).not.toContain('apps/web/src/routes/logout/+server.ts')
			for (const p of paths) {
				expect(p).not.toContain('/register/')
				expect(p).not.toContain('/forgot-password/')
				expect(p).not.toContain('/logout/')
			}
		}
	})
})

describe('generateFrontendSveltekit — fence stripping', () => {
	test('+layout.server.ts contains data?.user only when auth is on', () => {
		const off = generateFrontendSveltekit(makeCfg({ auth: [], email: 'skip' }))
		const on = generateFrontendSveltekit(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		const offFile = findEntry(off, 'apps/web/src/routes/+layout.server.ts')!
		const onFile = findEntry(on, 'apps/web/src/routes/+layout.server.ts')!
		expect(onFile.content).toContain('locals.user')
		expect(offFile.content).not.toContain('locals.user')
	})

	test('no-auth output removes auth-only imports and unused load parameters', () => {
		const entries = generateFrontendSveltekit(makeCfg({ auth: [], email: 'skip', i18n: 'skip' }))
		const nav = findEntry(entries, 'apps/web/src/lib/components/layout/nav.svelte')!.content
		const layout = findEntry(entries, 'apps/web/src/routes/+layout.server.ts')!.content
		expect(nav).not.toContain('UserIcon')
		expect(nav).not.toContain('LogOutIcon')
		expect(nav).not.toContain('@repo/ui/primitives/button')
		expect(nav).not.toContain('@repo/ui/primitives/dropdown-menu')
		expect(layout).toContain('export const load: LayoutServerLoad = () =>')
		expect(layout).not.toContain('locals')
	})

	test('hooks.server.ts attaches user only when auth is on', () => {
		const off = generateFrontendSveltekit(makeCfg({ auth: [], email: 'skip' }))
		const on = generateFrontendSveltekit(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		const offHooks = findEntry(off, 'apps/web/src/hooks.server.ts')!
		const onHooks = findEntry(on, 'apps/web/src/hooks.server.ts')!
		expect(onHooks.content).toContain('getSessionUser')
		expect(onHooks.content).toContain('attachUser')
		expect(offHooks.content).not.toContain('getSessionUser')
		expect(offHooks.content).not.toContain('attachUser')
	})

	test('Hono auth uses the same-origin client while integrated auth keeps PUBLIC_AUTH_URL', () => {
		const off = generateFrontendSveltekit(makeCfg({ auth: [], email: 'skip' }))
		const hono = generateFrontendSveltekit(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		const integrated = generateFrontendSveltekit(
			makeCfg({ backend: 'inside-frontend', auth: ['emailOTP'], email: 'resend' })
		)
		expect(findEntry(hono, 'apps/web/src/lib/auth/client.ts')!.content).not.toContain(
			'PUBLIC_AUTH_URL'
		)
		expect(findEntry(integrated, 'apps/web/src/lib/auth/client.ts')!.content).toContain(
			'PUBLIC_AUTH_URL'
		)
		expect(findEntry(off, 'apps/web/src/lib/auth/client.ts')).toBeUndefined()
	})

	test('app.d.ts user augmentation only present when auth is on', () => {
		const off = generateFrontendSveltekit(makeCfg({ auth: [], email: 'skip' }))
		const on = generateFrontendSveltekit(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		const offFile = findEntry(off, 'apps/web/src/app.d.ts')!
		const onFile = findEntry(on, 'apps/web/src/app.d.ts')!
		expect(onFile.content).toMatch(/user\s*[?:]/)
		expect(offFile.content).not.toMatch(/user\s*[?:]/)
	})

	test('no raw fence directives leak into any output for any flag combination', () => {
		for (const auth of AUTH_VARIANTS) {
			const email = auth.length > 0 ? 'resend' : 'skip'
			const entries = generateFrontendSveltekit(makeCfg({ auth, email }))
			for (const e of entries) {
				expect(e.content).not.toContain('@gvkit:if')
				expect(e.content).not.toContain('@gvkit:endif')
				expect(e.content).not.toContain('@gvkit:strip-without')
			}
		}
	})
})

describe('generateFrontendSveltekit — package.json merge', () => {
	test('auth fragment adds better-auth, zod, sveltekit-superforms, formsnap', () => {
		const entries = generateFrontendSveltekit(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		const pkg = findEntry(entries, 'apps/web/package.json')!
		const parsed = JSON.parse(pkg.content) as { dependencies: Record<string, string> }
		expect(parsed.dependencies['better-auth']).toBeDefined()
		expect(parsed.dependencies['zod']).toBeDefined()
		expect(parsed.dependencies['sveltekit-superforms']).toBeDefined()
		expect(parsed.dependencies['formsnap']).toBeDefined()
	})

	test('without --auth, those four deps are absent', () => {
		const entries = generateFrontendSveltekit(makeCfg({ auth: [], email: 'skip' }))
		const pkg = findEntry(entries, 'apps/web/package.json')!
		const parsed = JSON.parse(pkg.content) as { dependencies: Record<string, string> }
		expect(parsed.dependencies['better-auth']).toBeUndefined()
		expect(parsed.dependencies['sveltekit-superforms']).toBeUndefined()
		expect(parsed.dependencies['formsnap']).toBeUndefined()
	})
})

describe('generateFrontendSveltekit — variable substitution', () => {
	test('__PROJECT__ resolves into wrangler.jsonc and package.json', () => {
		const entries = generateFrontendSveltekit(makeCfg({ name: 'todos-cf-workers' }))
		const wrangler = findEntry(entries, 'apps/web/wrangler.jsonc')!
		expect(wrangler.content).toContain('todos-cf-workers-web')
		const pkg = findEntry(entries, 'apps/web/package.json')!
		const parsed = JSON.parse(pkg.content) as { name: string }
		expect(parsed.name).toBe('todos-cf-workers-web')
	})

	test('no unsubstituted __PLACEHOLDER__ tokens survive in any file', () => {
		const entries = generateFrontendSveltekit(
			makeCfg({ auth: ['emailOTP', 'google'], email: 'resend', name: 'demo' })
		)
		for (const e of entries) {
			expect(e.content).not.toContain('__PROJECT__')
			expect(e.content).not.toContain('__COMPAT_DATE__')
			expect(e.content).not.toContain('__AUTH_URL__')
		}
	})
})

describe('generateFrontendSveltekit — boundary regression', () => {
	test('NO entry path starts with apps/web/src/lib/components/ui/ for any flag combination', () => {
		for (const auth of AUTH_VARIANTS) {
			const email = auth.length > 0 ? 'resend' : 'skip'
			const entries = generateFrontendSveltekit(makeCfg({ auth, email }))
			for (const e of entries) {
				expect(e.path.startsWith('apps/web/src/lib/components/ui/')).toBe(false)
			}
		}
	})
})

describe('generateFrontendSveltekit — wrangler placement per deploy flag', () => {
	test('wrangler.jsonc emitted iff deploy is cf-workers', () => {
		const cf = generateFrontendSveltekit(makeCfg({ deploy: 'cf-workers' }))
		const docker = generateFrontendSveltekit(makeCfg({ deploy: 'docker' }))
		const skip = generateFrontendSveltekit(makeCfg({ deploy: 'skip' }))
		expect(findEntry(cf, 'apps/web/wrangler.jsonc')).toBeDefined()
		expect(findEntry(docker, 'apps/web/wrangler.jsonc')).toBeUndefined()
		expect(findEntry(skip, 'apps/web/wrangler.jsonc')).toBeUndefined()
	})

	test('wrangler.jsonc has apex routes (no api. prefix) and JSONC schema reference', () => {
		const entries = generateFrontendSveltekit(makeCfg({ deploy: 'cf-workers', backend: 'hono' }))
		const wrangler = findEntry(entries, 'apps/web/wrangler.jsonc')!
		expect(wrangler.content).toContain('"$schema"')
		expect(wrangler.content).toContain('"routes"')
		expect(wrangler.content).toContain('"compatibility_flags": ["nodejs_compat"]')
		expect(wrangler.content).not.toContain('nodejs_als')
		expect(wrangler.content).not.toContain('auth.api.')
	})

	test('Hono auth binds web SSR only to the gateway and emits no auth facade', () => {
		const honoAuth = generateFrontendSveltekit(
			makeCfg({
				deploy: 'cf-workers',
				backend: 'hono',
				auth: ['emailOTP'],
				email: 'resend'
			})
		)
		const wrangler = findEntry(honoAuth, 'apps/web/wrangler.jsonc')!.content
		expect(wrangler).toContain('"binding": "GATEWAY"')
		expect(wrangler).toContain('"service": "demo-api"')
		expect(wrangler).not.toContain('"binding": "AUTH"')
		expect(wrangler).not.toContain('BETTER_AUTH_SECRET')
		expect(
			findEntry(honoAuth, 'apps/web/src/routes/api/auth/[...path]/+server.ts')
		).toBeUndefined()
		const session = findEntry(honoAuth, 'apps/web/src/lib/server/load-session.ts')!
		expect(session.content).toContain("event.fetch('/api/auth/get-session'")
		const env = findEntry(honoAuth, 'apps/web/.env.example')!
		expect(env.content).not.toContain('PUBLIC_AUTH_URL')
	})
})

describe('generateFrontendSveltekit — project-shape ownership', () => {
	test('inside-web retains public homepage and SEO endpoints', () => {
		const entries = generateFrontendSveltekit(makeCfg({ marketing: 'inside-web' }))
		expect(findEntry(entries, 'apps/web/src/routes/+page.svelte')).toBeDefined()
		expect(findEntry(entries, 'apps/web/src/routes/robots.txt/+server.ts')).toBeDefined()
		expect(findEntry(entries, 'apps/web/src/routes/sitemap.xml/+server.ts')).toBeDefined()
		expect(findEntry(entries, 'apps/web/src/routes/+page.server.ts')).toBeUndefined()
	})

	test('Astro shape removes duplicate web SEO endpoints', () => {
		const entries = generateFrontendSveltekit(makeCfg({ marketing: 'astro' }))
		expect(findEntry(entries, 'apps/web/src/routes/robots.txt/+server.ts')).toBeUndefined()
		expect(findEntry(entries, 'apps/web/src/routes/sitemap.xml/+server.ts')).toBeUndefined()
	})

	test('Astro + auth redirects the web root according to locals.user', () => {
		const entries = generateFrontendSveltekit(
			makeCfg({ marketing: 'astro', auth: ['emailOTP'], email: 'resend' })
		)
		const root = findEntry(entries, 'apps/web/src/routes/+page.server.ts')
		expect(root).toBeDefined()
		expect(root!.content).toContain('locals.user')
		expect(root!.content).toContain("'/login'")
		expect(root!.content).toContain("'/me'")
	})

	test('Astro without auth keeps a normal application entry and no auth redirect', () => {
		const entries = generateFrontendSveltekit(
			makeCfg({ marketing: 'astro', auth: [], email: 'skip' })
		)
		expect(findEntry(entries, 'apps/web/src/routes/+page.svelte')).toBeDefined()
		expect(findEntry(entries, 'apps/web/src/routes/+page.server.ts')).toBeUndefined()
	})

	test('Astro Cloudflare shape assigns web to app.<domain>', () => {
		const entries = generateFrontendSveltekit(makeCfg({ marketing: 'astro', deploy: 'cf-workers' }))
		const wrangler = findEntry(entries, 'apps/web/wrangler.jsonc')!
		expect(wrangler.content).toContain('"pattern": "app.<domain>"')
		expect(wrangler.content).not.toContain('"pattern": "<domain>"')
	})
})

describe('generateFrontendSveltekit — server errors helper', () => {
	test('apps/web/src/lib/server/errors.ts is always emitted in the base fixture', () => {
		for (const auth of AUTH_VARIANTS) {
			const email = auth.length > 0 ? 'resend' : 'skip'
			const entries = generateFrontendSveltekit(makeCfg({ auth, email }))
			const errors = findEntry(entries, 'apps/web/src/lib/server/errors.ts')
			expect(errors).toBeDefined()
			expect(errors!.content).toContain('throwAppError')
			expect(errors!.content).toContain('guardAppError')
			expect(errors!.content).toContain('AppError')
			expect(errors!.content).toContain('httpStatusFor')
		}
	})
})

describe('generateFrontendSveltekit — hey-api / TanStack Query overlay', () => {
	test('apiClient=hey-api emits the query overlay; skip omits it', () => {
		const on = generateFrontendSveltekit(makeCfg({ apiClient: 'hey-api' }))
		const off = generateFrontendSveltekit(makeCfg({ apiClient: 'skip' }))
		expect(findEntry(on, 'apps/web/src/routes/+layout.ts')).toBeDefined()
		expect(findEntry(on, 'apps/web/src/routes/users/+page.svelte')).toBeDefined()
		expect(findEntry(off, 'apps/web/src/routes/+layout.ts')).toBeUndefined()
		expect(findEntry(off, 'apps/web/src/routes/users/+page.svelte')).toBeUndefined()
	})

	test('+layout.ts creates a per-request QueryClient and configures the generated client', () => {
		const layout = findEntry(
			generateFrontendSveltekit(makeCfg({ apiClient: 'hey-api' })),
			'apps/web/src/routes/+layout.ts'
		)!
		expect(layout.content).toContain('new QueryClient')
		expect(layout.content).toContain("from '@repo/openapi-client'")
		expect(layout.content).not.toContain('@repo/openapi-client/users')
		expect(layout.content).toContain("baseUrl: ''")
		expect(layout.content).not.toContain('PUBLIC_USERS_URL')
		// must spread parent (server) data so user/locale survive the universal load
		expect(layout.content).toContain('...data')
	})

	test('SSR uses the same root operation with the request-scoped fetch transport', () => {
		const serverLoad = findEntry(
			generateFrontendSveltekit(makeCfg({ apiClient: 'hey-api' })),
			'apps/web/src/routes/users/+page.server.ts'
		)!
		expect(serverLoad.content).toContain("usersGetMe } from '@repo/openapi-client'")
		expect(serverLoad.content).toContain('usersGetMe({ baseUrl: url.origin, fetch })')
		expect(serverLoad.content).not.toContain('@repo/openapi-client/users')
	})

	test('root +layout.svelte wraps children in QueryClientProvider only with hey-api', () => {
		const on = findEntry(
			generateFrontendSveltekit(makeCfg({ apiClient: 'hey-api' })),
			'apps/web/src/routes/+layout.svelte'
		)!
		const off = findEntry(
			generateFrontendSveltekit(makeCfg({ apiClient: 'skip' })),
			'apps/web/src/routes/+layout.svelte'
		)!
		expect(on.content).toContain('QueryClientProvider')
		expect(off.content).not.toContain('QueryClientProvider')
	})

	test('package.json gains @tanstack/svelte-query + @repo/openapi-client only with hey-api', () => {
		const parse = (apiClient: Choices['apiClient']) =>
			JSON.parse(
				findEntry(generateFrontendSveltekit(makeCfg({ apiClient })), 'apps/web/package.json')!
					.content
			) as { dependencies: Record<string, string> }
		const on = parse('hey-api')
		const off = parse('skip')
		expect(on.dependencies['@tanstack/svelte-query']).toBeDefined()
		expect(on.dependencies['@repo/openapi-client']).toBeDefined()
		expect(off.dependencies['@tanstack/svelte-query']).toBeUndefined()
		expect(off.dependencies['@repo/openapi-client']).toBeUndefined()
	})
	test('Google-only login does not emit email OTP-only bindings', () => {
		const entries = generateFrontendSveltekit(makeCfg({ auth: ['google'], email: 'skip' }))
		const login = findEntry(entries, 'apps/web/src/routes/login/+page.svelte')!.content
		for (const unused of [
			'Loader2Icon',
			'import * as Form',
			'import * as Input',
			'import { toast }',
			'fieldProxy',
			'setError',
			'import { goto }',
			'errors,',
			'submitting',
			'turnstileTokenProxy'
		])
			expect(login).not.toContain(unused)
		expect(login).toContain('continueWithGoogle')
	})
})
