import { describe, expect, test } from 'bun:test'
import {
	CLOUDFLARE_WORKER_NAME_LIMIT,
	cloudflareProductionWorkerName
} from '../../src/lib/cloudflare-worker-name.js'
import {
	AUTH_SERVICE,
	defineHonoTopology,
	hasLegacyHonoPublicRouteTable,
	honoPublicRoutes,
	HONO_PUBLIC_ROUTES,
	HONO_SERVICES,
	type HonoServiceTopology,
	USERS_SERVICE
} from '../../src/generators/hono-topology.js'

function usersWith(overrides: Partial<HonoServiceTopology>): HonoServiceTopology {
	return { ...USERS_SERVICE, ...overrides }
}

describe('Cloudflare production Worker names', () => {
	test('preserves names through the provider limit and bounds the next character', () => {
		const suffix = 'api'
		const exactProject = 'a'.repeat(CLOUDFLARE_WORKER_NAME_LIMIT - suffix.length - 1)
		const exactName = `${exactProject}-${suffix}`
		const oneOverProject = `${exactProject}a`

		expect(cloudflareProductionWorkerName({ project: exactProject, service: suffix })).toBe(
			exactName
		)
		expect(
			cloudflareProductionWorkerName({ project: oneOverProject, service: suffix })
		).toHaveLength(CLOUDFLARE_WORKER_NAME_LIMIT)
		expect(cloudflareProductionWorkerName({ project: oneOverProject, service: suffix })).toEndWith(
			'-api'
		)
		expect(cloudflareProductionWorkerName({ project: oneOverProject, service: suffix })).not.toBe(
			`${oneOverProject}-${suffix}`
		)
	})

	test('is deterministic and disambiguates long projects and service identities', () => {
		const leftProject = `a${'x'.repeat(999)}`
		const rightProject = `b${'x'.repeat(999)}`
		const leftApi = cloudflareProductionWorkerName({ project: leftProject, service: 'api' })
		const names = new Set([
			leftApi,
			cloudflareProductionWorkerName({ project: rightProject, service: 'api' }),
			cloudflareProductionWorkerName({ project: leftProject, service: 'auth' }),
			cloudflareProductionWorkerName({ project: leftProject, service: 'users' })
		])

		expect(cloudflareProductionWorkerName({ project: leftProject, service: 'api' })).toBe(leftApi)
		expect(names.size).toBe(4)
		for (const name of names) expect(name.length).toBeLessThanOrEqual(CLOUDFLARE_WORKER_NAME_LIMIT)
	})
})

describe('Hono topology contracts', () => {
	test('describes the generated auth and users topology', () => {
		expect(
			HONO_SERVICES.map((service) => ({
				identity: service.identity,
				workspacePath: service.workspacePath,
				packageName: service.packageName,
				publicPrefixes: service.publicPrefixes,
				internalTarget: service.internalTarget,
				port: service.development.port,
				cfServiceNameSuffix: service.transport.cfWorkers.serviceNameSuffix,
				dockerHostname: service.transport.docker.hostname,
				nodeTargetEnvironmentVariable: service.transport.node.targetEnvironmentVariable
			}))
		).toEqual([
			{
				identity: 'auth',
				workspacePath: 'services/auth',
				packageName: 'auth-worker',
				publicPrefixes: ['/api/auth'],
				internalTarget: 'AUTH',
				port: 8787,
				cfServiceNameSuffix: 'auth',
				dockerHostname: 'auth',
				nodeTargetEnvironmentVariable: 'AUTH_URL'
			},
			{
				identity: 'users',
				workspacePath: 'services/users',
				packageName: 'users-worker',
				publicPrefixes: ['/api/v1/users'],
				internalTarget: 'USERS',
				port: 8788,
				cfServiceNameSuffix: 'users',
				dockerHostname: 'users',
				nodeTargetEnvironmentVariable: 'USERS_URL'
			}
		])
	})

	test('rejects duplicate service identities', () => {
		expect(() =>
			defineHonoTopology([
				AUTH_SERVICE,
				usersWith({ identity: AUTH_SERVICE.identity })
			])
		).toThrow('duplicate service identity: auth')
	})

	test('rejects duplicate internal target names', () => {
		expect(() =>
			defineHonoTopology([
				AUTH_SERVICE,
				usersWith({ internalTarget: AUTH_SERVICE.internalTarget })
			])
		).toThrow('duplicate internal target name: AUTH')
	})

	test('flattens public prefixes into explicit target routes', () => {
		expect(HONO_PUBLIC_ROUTES).toEqual([
			{ owner: 'auth', prefix: '/api/auth', target: 'AUTH' },
			{ owner: 'users', prefix: '/api/v1/users', target: 'USERS' }
		])
	})

	test('limits legacy byte compatibility to the frozen auth and users route table', () => {
		expect(hasLegacyHonoPublicRouteTable(HONO_SERVICES)).toBe(true)
		expect(
			hasLegacyHonoPublicRouteTable(
				defineHonoTopology([
					AUTH_SERVICE,
					usersWith({ publicPrefixes: ['/api/v1/users', '/api/profiles'] })
				])
			)
		).toBe(false)
	})

	test('orders a more specific prefix before its ancestor without reordering unrelated routes', () => {
		const services = defineHonoTopology([
			{ ...AUTH_SERVICE, publicPrefixes: ['/api/auth', '/api/v1'] },
			usersWith({ publicPrefixes: ['/api/v1/users', '/api/profiles'] })
		])

		expect(honoPublicRoutes(services)).toEqual([
			{ owner: 'auth', prefix: '/api/auth', target: 'AUTH' },
			{ owner: 'users', prefix: '/api/v1/users', target: 'USERS' },
			{ owner: 'auth', prefix: '/api/v1', target: 'AUTH' },
			{ owner: 'users', prefix: '/api/profiles', target: 'USERS' }
		])
	})

	test('rejects duplicate public-prefix ownership across services with both owners', () => {
		expect(() =>
			defineHonoTopology([
				AUTH_SERVICE,
				usersWith({ publicPrefixes: AUTH_SERVICE.publicPrefixes })
			])
		).toThrow(
			'public prefix "/api/auth" has ambiguous ownership between "auth" publicPrefixes[0] and "users" publicPrefixes[0]'
		)
	})

	test('rejects duplicate public-prefix ownership within one service with both positions', () => {
		expect(() =>
			defineHonoTopology([
				usersWith({ publicPrefixes: ['/api/v1/users', '/api/v1/users'] })
			])
		).toThrow(
			'public prefix "/api/v1/users" has ambiguous ownership between "users" publicPrefixes[0] and "users" publicPrefixes[1]'
		)
	})

	test('rejects non-canonical and gateway-owned public prefixes with the owner position', () => {
		expect(() =>
			defineHonoTopology([usersWith({ publicPrefixes: ['/api/v1/users/'] })])
		).toThrow(
			'public prefix "/api/v1/users/" at "users" publicPrefixes[0] is ambiguous'
		)
		expect(() =>
			defineHonoTopology([usersWith({ publicPrefixes: ['/api/openapi.json'] })])
		).toThrow(
			'public prefix "/api/openapi.json" at "users" publicPrefixes[0] conflicts with a gateway-owned operational route'
		)
	})

	test('rejects duplicate development ports', () => {
		expect(() =>
			defineHonoTopology([
				AUTH_SERVICE,
				usersWith({ development: AUTH_SERVICE.development })
			])
		).toThrow('duplicate development port: 8787')
	})
})
