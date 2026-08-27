import { describe, expect, test } from 'bun:test'
import { generateDeploy } from '../../src/generators/deploy.js'
import { runGenerators } from '../../src/generators/index.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const choices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'inside-web',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'postgres',
	apiClient: 'hey-api',
	auth: ['emailOTP'],
	email: 'resend',
	aiTooling: [],
	deploy: 'docker'
}

const config: GvKitConfig = { configVersion: 2, choices }
const noAuthConfig: GvKitConfig = {
	configVersion: 2,
	choices: {
		...choices,
		name: 'no-auth',
		marketing: 'astro',
		db: 'sqlite',
		apiClient: 'skip',
		auth: [],
		email: 'skip'
	}
}

function generated(path: string): string {
	return generateDeploy(config).find((entry) => entry.path === path)!.content
}

function scaffold(path: string, source = config): string {
	return runGenerators(source).find((entry) => entry.path === path)!.content
}

function composeServices(): Record<string, Record<string, unknown>> {
	const document = Bun.YAML.parse(generated('docker-compose.yml')) as {
		services: Record<string, Record<string, unknown>>
	}
	return document.services
}

describe('Docker gateway topology', () => {
	test('publishes only ingress and gateway while keeping auth and users private', () => {
		const services = composeServices()

		expect(Object.keys(services).sort()).toEqual([
			'auth',
			'gateway',
			'ingress',
			'migrate',
			'postgres',
			'users',
			'web'
		])
		expect(services.ingress?.ports).toEqual(['3000:8080'])
		expect(services.gateway?.ports).toEqual(['8786:8786'])
		expect(services.auth?.ports).toBeUndefined()
		expect(services.users?.ports).toBeUndefined()
		expect(services.web?.ports).toBeUndefined()
	})

	test('routes the web API alias and canonical API host to the same gateway', () => {
		const config = generated('docker/ingress.conf.template')

		expect(config).toContain('server_name ${API_HOST};')
		expect(config).toMatch(
			/server_name _;[\s\S]*location = \/api[\s\S]*proxy_pass http:\/\/gateway_upstream/
		)
		expect(config).toMatch(
			/server_name _;[\s\S]*location \^~ \/api\/[\s\S]*proxy_pass http:\/\/gateway_upstream/
		)
		expect(config).toMatch(
			/server_name _;[\s\S]*location \/[\s\S]*proxy_pass http:\/\/web_upstream/
		)
		expect(config).toMatch(
			/server_name \$\{API_HOST\};[\s\S]*location \/[\s\S]*proxy_pass http:\/\/gateway_upstream/
		)
		expect(config).toContain('proxy_set_header X-Forwarded-Proto ${PUBLIC_SCHEME};')
		expect(config).toContain(
			'proxy_set_header X-Gateway-Ingress-Secret ${GATEWAY_TRUSTED_INGRESS_SECRET};'
		)
	})

	test('uses explicit private gateway and service transports with readiness ordering', () => {
		const services = composeServices()
		const environment = (name: string) => services[name]?.environment as Record<string, string>
		const dependencies = (name: string) => services[name]?.depends_on as Record<string, unknown>

		expect(environment('web').GATEWAY_URL).toBe('http://gateway:8786')
		expect(environment('web').AUTH_URL).toBeUndefined()
		expect(environment('web').USERS_URL).toBeUndefined()
		expect(environment('gateway').AUTH_URL).toBe('http://auth:8787')
		expect(environment('gateway').USERS_URL).toBe('http://users:8788')
		expect(environment('gateway').API_PUBLIC_ORIGIN).toBe(
			'${API_PUBLIC_ORIGIN:-http://api.localhost:3000}'
		)
		expect(environment('gateway').GATEWAY_PUBLIC_ORIGINS).toBe(
			'${GATEWAY_PUBLIC_ORIGINS:-http://localhost:3000,http://api.localhost:3000,http://localhost:8786,http://127.0.0.1:8786}'
		)
		expect(environment('gateway').GATEWAY_TRUSTED_INGRESS_SECRET).toBe(
			'${GATEWAY_TRUSTED_INGRESS_SECRET:?set GATEWAY_TRUSTED_INGRESS_SECRET in .env}'
		)
		expect(environment('web').GATEWAY_TRUSTED_INGRESS_SECRET).toBe(
			'${GATEWAY_TRUSTED_INGRESS_SECRET:?set GATEWAY_TRUSTED_INGRESS_SECRET in .env}'
		)
		expect(environment('ingress').GATEWAY_TRUSTED_INGRESS_SECRET).toBe(
			'${GATEWAY_TRUSTED_INGRESS_SECRET:?set GATEWAY_TRUSTED_INGRESS_SECRET in .env}'
		)
		expect(environment('gateway').API_CORS_ORIGINS).toBe(
			'${API_CORS_ORIGINS:-http://localhost:3000}'
		)
		expect(environment('auth').BETTER_AUTH_ALLOWED_HOSTS).toBe(
			'${BETTER_AUTH_ALLOWED_HOSTS:-localhost:3000,api.localhost:3000,localhost:8786,127.0.0.1:8786}'
		)
		expect(environment('auth').AUTH_CORS_ORIGINS).toBe(
			'${AUTH_CORS_ORIGINS:-http://localhost:3000,http://api.localhost:3000}'
		)
		expect(environment('gateway').GATEWAY_UPSTREAM_TIMEOUT_MS).toBe(
			'${GATEWAY_UPSTREAM_TIMEOUT_MS:-10000}'
		)
		expect(environment('users').AUTH_URL).toBe('http://auth:8787')
		expect(dependencies('auth')).toHaveProperty(
			'migrate.condition',
			'service_completed_successfully'
		)
		expect(dependencies('users')).toHaveProperty('auth.condition', 'service_healthy')
		expect(dependencies('gateway')).toHaveProperty('users.condition', 'service_healthy')
		expect(dependencies('web')).toEqual({ gateway: { condition: 'service_healthy' } })
		expect(dependencies('ingress')).toEqual({
			gateway: { condition: 'service_healthy' },
			web: { condition: 'service_healthy' }
		})
	})

	test('builds dedicated gateway, web, auth, and users runtime targets', () => {
		const dockerfile = generated('Dockerfile')
		const services = composeServices()
		const target = (name: string) =>
			(services[name]?.build as { target?: string } | undefined)?.target

		for (const name of ['gateway', 'web', 'auth', 'users']) {
			expect(dockerfile).toContain(`AS ${name}-runtime`)
			expect(target(name)).toBe(`${name}-runtime`)
		}
	})

	test('packages compiled Paraglide output for Hono Docker workspace deploys', () => {
		const dockerI18nConfig: GvKitConfig = {
			...config,
			choices: { ...choices, i18n: 'paraglide' }
		}
		const entries = runGenerators(dockerI18nConfig)
		const entry = (path: string) => entries.find((candidate) => candidate.path === path)
		const packageJson = JSON.parse(entry('packages/i18n/package.json')!.content) as {
			scripts: { build: string }
		}

		expect(entry('packages/i18n/.npmignore')?.content).toBe('node_modules/\n')
		expect(packageJson.scripts.build).toContain(
			"writeFileSync('src/paraglide/.npmignore', '')"
		)
	})

	test('containerized Node entrypoints honor HOST while local defaults remain loopback-only', () => {
		for (const path of [
			'apps/api/src/index.ts',
			'services/auth/src/index.ts',
			'services/users/src/index.ts'
		]) {
			const entrypoint = scaffold(path)
			expect(entrypoint, path).toContain("process.env.HOST ?? '127.0.0.1'")
			expect(entrypoint, path).toContain('hostname')
		}
	})

	test('Node SSR falls back to the private gateway URL without a Cloudflare env', () => {
		const hooks = scaffold('apps/web/src/hooks.server.ts')

		expect(hooks).toContain('event.platform?.env?.GATEWAY')
		expect(hooks).toContain("env.GATEWAY_URL ?? 'http://127.0.0.1:8786'")
		expect(hooks).toContain("forwarded.headers.set('host', event.url.host)")
		expect(hooks).toContain("forwarded.headers.set('x-forwarded-host', event.url.host)")
		expect(hooks).toContain(
			"forwarded.headers.set('x-forwarded-proto', event.url.protocol.slice(0, -1))"
		)
	})

	test('gateway derives auth callback metadata from its public-origin allowlist', () => {
		const app = scaffold('apps/api/src/app.ts')
		const entrypoint = scaffold('apps/api/src/index.ts')

		expect(app).toContain("headers.set('x-forwarded-host', publicOrigin.host)")
		expect(app).toContain("headers.set('x-forwarded-proto', publicOrigin.protocol)")
		expect(entrypoint).toContain('publicOrigins: process.env.GATEWAY_PUBLIC_ORIGINS')
		expect(entrypoint).toContain('trustedIngressSecret')
		expect(entrypoint).not.toContain("request.headers.get('x-forwarded-host')")
		expect(entrypoint).not.toContain("request.headers.get('x-forwarded-proto')")
	})

	test('runs the mandatory private auth transport without public auth when no provider is selected', () => {
		const entries = runGenerators(noAuthConfig)
		const compose = Bun.YAML.parse(
			entries.find(({ path }) => path === 'docker-compose.yml')!.content
		) as { services: Record<string, { environment?: Record<string, string>; ports?: unknown }> }
		const authPackage = JSON.parse(scaffold('services/auth/package.json', noAuthConfig)) as {
			dependencies: Record<string, string>
		}
		const authApp = scaffold('services/auth/src/app.ts', noAuthConfig)

		expect(compose.services.auth?.environment).toEqual({ PORT: '8787' })
		expect(compose.services.auth?.ports).toBeUndefined()
		expect(authPackage.dependencies['better-auth']).toBeUndefined()
		expect(authPackage.dependencies['@repo/db']).toBeUndefined()
		expect(entries.some(({ path }) => path === 'services/auth/src/auth.ts')).toBe(false)
		expect(entries.some(({ path }) => path === 'services/auth/src/lib/utils.ts')).toBe(false)
		expect(authApp).not.toContain('/api/auth')
		expect(authApp).toContain("return c.json({ error: 'unauthorized' }, 401)")
	})

	test('supports credential-free local OTP verification without removing production email settings', () => {
		const services = composeServices()
		const authEnvironment = services.auth?.environment as Record<string, string>
		const webBuild = services.web?.build as { args: Record<string, string> }

		expect(authEnvironment.BETTER_AUTH_SECRET).toContain('set BETTER_AUTH_SECRET')
		expect(authEnvironment.BETTER_AUTH_SECRET).not.toContain(':-')
		expect(authEnvironment.TURNSTILE_SECRET_KEY).toContain('set TURNSTILE_SECRET_KEY')
		expect(authEnvironment.RESEND_API_KEY).toBe('${RESEND_API_KEY:-}')
		expect(authEnvironment.FROM_EMAIL).toBe('${FROM_EMAIL:-}')
		expect(webBuild.args.PUBLIC_TURNSTILE_SITE_KEY).toBe(
			'${PUBLIC_TURNSTILE_SITE_KEY:-1x00000000000000000000AA}'
		)
	})
})
