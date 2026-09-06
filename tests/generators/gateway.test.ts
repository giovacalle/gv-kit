import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { renderCoreStackRule } from '../../src/generators/ai-tooling-rules.js'
import {
	generateGateway,
	generateGatewayForTopology
} from '../../src/generators/gateway.js'
import {
	AUTH_SERVICE,
	defineHonoTopology,
	USERS_SERVICE
} from '../../src/generators/hono-topology.js'
import { renderApiTopology } from '../../src/generators/root.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')

function generateFixture(name: string) {
	const raw = parseJsonc(readFileSync(join(fixturesDir, `${name}.jsonc`), 'utf8'))
	return generateGateway(GvKitConfig.parse(raw))
}

function content(entries: ReturnType<typeof generateGateway>, path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`Missing generated file: ${path}`)
	return entry.content
}

describe('generateGateway', () => {
	test('keeps apex-domain setup guidance in the Cloudflare README instead of Wrangler comments', () => {
		const entries = generateFixture('hono-cf-workers-passwordless')
		const wrangler = content(entries, 'apps/api/wrangler.jsonc')
		const readme = content(entries, 'apps/api/README.md')

		expect(wrangler).not.toContain("// Replace <domain> with the project's apex domain.")
		expect(readme).toContain(
			"Before deploying to Cloudflare, replace each `<domain>` placeholder in `wrangler.jsonc` with the project's apex domain."
		)
	})

	test('does not emit Cloudflare domain setup guidance for a Node gateway', () => {
		const entries = generateFixture('hono-skip-deploy')
		const readme = content(entries, 'apps/api/README.md')

		expect(entries.some((entry) => entry.path === 'apps/api/wrangler.jsonc')).toBe(false)
		expect(readme).not.toContain('Before deploying to Cloudflare')
	})

	test('switches canonical generation from the legacy fallback when configured prefixes change', () => {
		const raw = parseJsonc(
			readFileSync(join(fixturesDir, 'hono-skip-deploy.jsonc'), 'utf8')
		)
		const cfg = GvKitConfig.parse(raw)
		const legacyComposer = content(
			generateGateway(cfg),
			'apps/api/scripts/compose-openapi.ts'
		)

		expect(legacyComposer).not.toContain('const publicRoutes = [')
		expect(renderCoreStackRule(cfg)).not.toContain('Owned prefix routes:')
		expect(renderApiTopology(cfg)).not.toContain('Owned public prefixes:')

		const configuredServices = defineHonoTopology([
			AUTH_SERVICE,
			{ ...USERS_SERVICE, publicPrefixes: ['/api/v1/users', '/api/profiles'] }
		])
		const configuredComposer = content(
			generateGatewayForTopology({ cfg, services: configuredServices }),
			'apps/api/scripts/compose-openapi.ts'
		)

		expect(configuredComposer).toContain('const publicRoutes = [')
		expect(configuredComposer).toContain("prefix: '/api/profiles'")
		expect(renderCoreStackRule(cfg, configuredServices)).toContain('/api/profiles/*')
		expect(renderApiTopology(cfg, configuredServices)).toContain('/api/profiles/*')
	})

	test('renders full contracts for a changed one-prefix-per-service topology', async () => {
		const raw = parseJsonc(
			readFileSync(join(fixturesDir, 'hono-skip-deploy.jsonc'), 'utf8')
		)
		const cfg = GvKitConfig.parse(raw)
		const services = defineHonoTopology([
			{ ...AUTH_SERVICE, publicPrefixes: ['/api/v1/invoices'] },
			{ ...USERS_SERVICE, publicPrefixes: ['/api/v1/users'] }
		])
		const entries = generateGatewayForTopology({ cfg, services })
		const composer = content(entries, 'apps/api/scripts/compose-openapi.ts')
		const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
		const composerUrl = URL.createObjectURL(
			new Blob([transpiler.transformSync(composer)], { type: 'text/javascript' })
		)
		const composerModule = (await import(composerUrl)) as {
			composeOpenApi(fragments: readonly unknown[]): {
				paths: Record<string, unknown>
			}
		}
		URL.revokeObjectURL(composerUrl)

		expect(() =>
			composerModule.composeOpenApi([
				{
					owner: 'users',
					operationIdPrefix: 'users',
					document: {
						openapi: '3.0.0',
						info: { title: 'Users', version: '0.0.0' },
						paths: {
							'/api/v1/invoices/list': {
								get: {
									operationId: 'usersListInvoices',
									responses: { 200: { description: 'ok' } }
								}
							}
						}
					}
				}
			])
		).toThrow(
			'fragment "users" path "/api/v1/invoices/list" routes to "auth" through the more specific prefix "/api/v1/invoices"'
		)
		for (const guidance of [renderCoreStackRule(cfg, services), renderApiTopology(cfg, services)]) for (const prefix of ['/api/v1/invoices/*', '/api/v1/users/*']) expect(guidance).toContain(prefix)
	})

	test('renders and routes every prefix owned by a synthetic multi-prefix service', async () => {
		const raw = parseJsonc(
			readFileSync(join(fixturesDir, 'hono-skip-deploy.jsonc'), 'utf8')
		)
		const cfg = GvKitConfig.parse(raw)
		const services = defineHonoTopology([
			{
				...AUTH_SERVICE,
				publicPrefixes: ['/api/auth', '/api/v1', '/api/profiles/me']
			},
			{ ...USERS_SERVICE, publicPrefixes: ['/api/v1/users', '/api/profiles'] }
		])
		const entries = generateGatewayForTopology({ cfg, services })
		const appSource = content(entries, 'apps/api/src/app.ts')
		const composer = content(entries, 'apps/api/scripts/compose-openapi.ts')
		const readme = content(entries, 'apps/api/README.md')
		const honoUrl = import.meta.resolve('hono')
		const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
		const javascript = transpiler.transformSync(
			appSource.replace("from 'hono'", `from '${honoUrl}'`)
		)
		const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
		const module = (await import(moduleUrl)) as {
			createGateway(
				targets: Record<string, { fetch(request: Request): Promise<Response> }>,
				options: {
					openApiDocument: { openapi: string; info: Record<string, unknown>; paths: Record<string, unknown> }
					canonicalApiOrigin: string
					publicOrigins: string
					corsOrigins?: string
				}
			): { fetch(request: Request): Promise<Response> }
		}
		URL.revokeObjectURL(moduleUrl)
		const calls: string[] = []
		const gateway = module.createGateway(
			{
				AUTH: {
					async fetch(request) {
						calls.push(`AUTH:${new URL(request.url).pathname}`)
						return new Response('auth')
					}
				},
				USERS: {
					async fetch(request) {
						calls.push(`USERS:${new URL(request.url).pathname}`)
						return new Response('users')
					}
				}
			},
			{
				openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
				canonicalApiOrigin: 'http://web.test',
				publicOrigins: 'http://web.test',
				corsOrigins: 'http://client.test'
			}
		)

		expect(
			await (await gateway.fetch(new Request('http://web.test/api/v1/users/me'))).text()
		).toBe('users')
		expect(
			await (await gateway.fetch(new Request('http://web.test/api/profiles/list'))).text()
		).toBe('users')
		expect(
			await (await gateway.fetch(new Request('http://web.test/api/v1/other'))).text()
		).toBe('auth')
		const preflight = await gateway.fetch(
			new Request('http://web.test/api/profiles/list', {
				method: 'OPTIONS',
				headers: {
					origin: 'http://client.test',
					'access-control-request-method': 'GET'
				}
			})
		)
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('access-control-allow-origin')).toBe(
			'http://client.test'
		)
		expect(calls).toEqual([
			'USERS:/api/v1/users/me',
			'USERS:/api/profiles/list',
			'AUTH:/api/v1/other'
		])

		for (const row of [
			'| /api/auth/* | AUTH |',
			'| /api/v1/users/* | USERS |',
			'| /api/v1/* | AUTH |',
			'| /api/profiles/me/* | AUTH |',
			'| /api/profiles/* | USERS |'
		]) expect(readme).toContain(row)
		expect(readme).toContain(
			'The prefix-to-target table below is part of this rollout contract.'
		)
		for (const prefix of [
			'/api/auth',
			'/api/v1/users',
			'/api/v1',
			'/api/profiles/me',
			'/api/profiles'
		]) expect(composer).toContain(`prefix: '${prefix}'`)
		expect(composer).toContain('is outside the public route table')
		const composerJavaScript = transpiler.transformSync(composer)
		const composerUrl = URL.createObjectURL(
			new Blob([composerJavaScript], { type: 'text/javascript' })
		)
		const composerModule = (await import(composerUrl)) as {
			composeOpenApi(fragments: readonly unknown[]): {
				paths: Record<string, unknown>
			}
		}
		URL.revokeObjectURL(composerUrl)
		const composed = composerModule.composeOpenApi([
			{
				owner: 'users',
				operationIdPrefix: 'users',
				publicPrefixes: ['/api/v1/users', '/api/profiles'],
				document: {
					openapi: '3.0.0',
					info: { title: 'Users', version: '0.0.0' },
					paths: {
						'/api/profiles/list': {
							get: {
								operationId: 'usersGetProfile',
								responses: { 200: { description: 'ok' } }
							}
						}
					}
				}
			}
		])
		expect(Object.keys(composed.paths)).toEqual(['/api/profiles/list'])
		expect(() =>
			composerModule.composeOpenApi([
				{
					owner: 'users',
					operationIdPrefix: 'users',
					publicPrefixes: ['/api/v1/users', '/api/profiles'],
					document: {
						openapi: '3.0.0',
						info: { title: 'Users', version: '0.0.0' },
						paths: {
							'/api/profiles/me': {
								get: {
									operationId: 'usersGetProfile',
									responses: { 200: { description: 'ok' } }
								}
							}
						}
					}
				}
			])
		).toThrow(
			'fragment "users" path "/api/profiles/me" routes to "auth" through the more specific prefix "/api/profiles/me"'
		)
		for (const guidance of [renderCoreStackRule(cfg, services), renderApiTopology(cfg, services)]) {
			for (const prefix of [
				'/api/auth/*',
				'/api/v1/users/*',
				'/api/v1/*',
				'/api/profiles/me/*',
				'/api/profiles/*'
			]) expect(guidance).toContain(prefix)
		}
	})
})
