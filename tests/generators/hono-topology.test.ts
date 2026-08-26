import { describe, expect, test } from 'bun:test'
import {
	AUTH_SERVICE,
	defineHonoTopology,
	HONO_SERVICES,
	type HonoServiceTopology,
	USERS_SERVICE
} from '../../src/generators/hono-topology.js'

function usersWith(overrides: Partial<HonoServiceTopology>): HonoServiceTopology {
	return { ...USERS_SERVICE, ...overrides }
}

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

	test('rejects duplicate public-prefix ownership', () => {
		expect(() =>
			defineHonoTopology([
				AUTH_SERVICE,
				usersWith({ publicPrefixes: AUTH_SERVICE.publicPrefixes })
			])
		).toThrow('duplicate public prefix: /api/auth')
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
