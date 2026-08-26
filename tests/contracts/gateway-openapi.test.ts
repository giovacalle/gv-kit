import { describe, expect, test } from 'bun:test'
import { generateGateway } from '../../src/generators/gateway.js'
import {
	composeGatewayOpenApi,
	createUsersOpenApiFragment,
	stringifyOpenApi,
	type OpenApiDocument,
	type OpenApiFragment
} from '../../src/generators/openapi-contract.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'inside-web',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'sqlite',
	apiClient: 'hey-api',
	auth: ['emailOTP'],
	email: 'resend',
	aiTooling: [],
	deploy: 'skip'
}

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return { configVersion: 2, choices: { ...baseChoices, ...overrides } }
}

function entry(path: string, cfg = makeCfg()): string {
	const hit = generateGateway(cfg).find((candidate) => candidate.path === path)
	if (!hit) throw new Error(`expected generated entry ${path}`)
	return hit.content
}

function fragment(owner: string, document: OpenApiDocument): OpenApiFragment {
	return { owner, operationIdPrefix: owner, document }
}

function document({
	path = '/api/v1/example',
	operationId = 'exampleGet',
	pathItem = {}
}: {
	path?: string
	operationId?: string
	pathItem?: Record<string, unknown>
} = {}): OpenApiDocument {
	return {
		openapi: '3.0.0',
		info: { title: 'fragment', version: '0.0.0' },
		paths: {
			[path]: {
				...pathItem,
				get: { operationId, responses: { 200: { description: 'ok' } } }
			}
		}
	}
}

function callbackFragment(location: 'components' | 'operation'): OpenApiFragment {
	const value = document({ path: '/api/v1/jobs', operationId: 'jobsCreate' })
	const callback = {
		'{$request.body#/callbackUrl}': {
			post: {
				operationId: 'jobsCreate',
				responses: { 200: { description: 'ok' } }
			}
		}
	}
	if (location === 'operation') {
		const operation = value.paths['/api/v1/jobs']!.get as Record<string, unknown>
		operation.callbacks = { onComplete: callback }
	} else {
		value.components = { callbacks: { onComplete: callback } }
	}
	return fragment('jobs', value)
}

function deploymentServerFragment(location: 'operation' | 'path'): OpenApiFragment {
	const value = document()
	const pathItem = value.paths['/api/v1/example'] as Record<string, unknown>
	if (location === 'path') pathItem.servers = [{ url: 'https://path-deploy.example' }]
	else {
		const operation = pathItem.get as Record<string, unknown>
		operation.servers = [{ url: 'https://operation-deploy.example' }]
	}
	return fragment('example', value)
}

function linkObjectFragment(
	location: 'component-response' | 'components' | 'operation-response'
): OpenApiFragment {
	const value = document()
	const link = {
		operationId: 'exampleGet',
		server: { url: 'https://deploy.example' }
	}
	if (location === 'components') value.components = { links: { Deployment: link } }
	else if (location === 'component-response') {
		const operation = value.paths['/api/v1/example']!.get as Record<string, unknown>
		operation.responses = { 200: { $ref: '#/components/responses/Deployment' } }
		value.components = {
			responses: {
				Deployment: { description: 'ok', links: { deployment: link } }
			}
		}
	} else {
		const operation = value.paths['/api/v1/example']!.get as Record<string, unknown>
		operation.responses = {
			200: { description: 'ok', links: { deployment: link } }
		}
	}
	return fragment('example', value)
}

function referencedPathItemFragment(): OpenApiFragment {
	const value = document({ path: '/api/v1/jobs', operationId: 'jobsCreate' })
	value.paths['/api/v1/referenced-jobs'] = {
		$ref: '#/components/x-pathItems/Jobs'
	}
	value.components = {
		'x-pathItems': {
			Jobs: {
				servers: [{ url: 'https://deploy.example' }],
				post: {
					operationId: 'jobsCreate',
					responses: { 200: { description: 'ok' } }
				}
			}
		}
	}
	return fragment('jobs', value)
}

function referencedParameterCollisionFragment(): OpenApiFragment {
	const value = document()
	const operation = value.paths['/api/v1/example']!.get as Record<string, unknown>
	operation.parameters = [
		{ $ref: '#/components/parameters/TextLimit' },
		{ $ref: '#/components/parameters/NumericLimit' }
	]
	value.components = {
		parameters: {
			TextLimit: { in: 'query', name: 'limit', schema: { type: 'string' } },
			NumericLimit: { in: 'query', name: 'limit', schema: { type: 'number' } }
		}
	}
	return fragment('example', value)
}

function compose(fragments: OpenApiFragment[]) {
	return composeGatewayOpenApi({ title: 'Gateway', version: '0.0.0', fragments })
}

async function loadGeneratedComposer() {
	const source = entry('apps/api/scripts/compose-openapi.ts')
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(source)
	const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
	const module = (await import(moduleUrl)) as {
		composeOpenApi(fragments: OpenApiFragment[]): OpenApiDocument
	}
	URL.revokeObjectURL(moduleUrl)
	return module.composeOpenApi
}

async function loadGeneratedGateway() {
	const source = entry('apps/api/src/app.ts')
	const honoUrl = import.meta.resolve('hono')
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(source.replace("from 'hono'", `from '${honoUrl}'`))
	const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
	const module = (await import(moduleUrl)) as {
		createGateway(
			targets: Record<string, never>,
			options: { openApiDocument: OpenApiDocument; canonicalApiOrigin: string }
		): { fetch(request: Request): Promise<Response> }
	}
	URL.revokeObjectURL(moduleUrl)
	return module
}

describe('gateway OpenAPI composition', () => {
	test('composes service-owned public fragments deterministically without auth or servers', () => {
		const users = createUsersOpenApiFragment({ project: 'demo', hasAuth: true })
		const invoices = fragment(
			'invoices',
			document({ path: '/api/v1/invoices', operationId: 'invoicesList' })
		)
		const forward = compose([users, invoices])
		const reverse = compose([invoices, users])

		expect(stringifyOpenApi(forward)).toBe(stringifyOpenApi(reverse))
		expect(Object.keys(forward.paths)).toEqual(['/api/v1/invoices', '/api/v1/users/me'])
		expect(stringifyOpenApi(forward)).toContain('usersGetMe')
		expect(stringifyOpenApi(forward)).not.toContain('/api/auth')
		expect(forward.servers).toBeUndefined()
	})

	test('emits the same checked document that its explicit composition command regenerates', () => {
		const checked = entry('apps/api/openapi.json')
		const composer = entry('apps/api/scripts/compose-openapi.ts')
		const gatewayPackage = JSON.parse(entry('apps/api/package.json')) as {
			scripts: Record<string, string>
		}

		expect(JSON.parse(checked).servers).toBeUndefined()
		expect(composer).toContain("owner: 'users'")
		expect(composer).toContain("'../../../services/users/openapi.json'")
		expect(composer).not.toContain('readdir')
		expect(composer).not.toContain('localeCompare')
		expect(composer).toContain('--check')
		expect(composer).toContain('sha256')
		expect(gatewayPackage.scripts['openapi:compose']).toContain('compose-openapi.ts')
		expect(gatewayPackage.scripts['openapi:check']).toContain('--check')
	})

	test('rejects duplicate operation IDs and incompatible method collisions', () => {
		expect(() =>
			compose([
				fragment('example', document()),
				{
					owner: 'other',
					operationIdPrefix: 'example',
					document: document({ path: '/api/v1/other', operationId: 'exampleGet' })
				}
			])
		).toThrow('duplicate operationId "exampleGet"')

		expect(() =>
			compose([
				fragment('example', document()),
				fragment('other', document({ operationId: 'otherGet' }))
			])
		).toThrow('method collision at paths./api/v1/example.get')
	})

	test('rejects operation and reusable component callbacks with actionable errors', () => {
		expect(() => compose([callbackFragment('operation')])).toThrow(
			'uses unsupported callbacks at paths./api/v1/jobs.get.callbacks'
		)
		expect(() => compose([callbackFragment('components')])).toThrow(
			'uses unsupported callbacks at components.callbacks'
		)
	})

	test('rejects path and operation deployment servers with actionable errors', () => {
		expect(() => compose([deploymentServerFragment('path')])).toThrow(
			'must not declare servers at paths./api/v1/example.servers'
		)
		expect(() => compose([deploymentServerFragment('operation')])).toThrow(
			'must not declare servers at paths./api/v1/example.get.servers'
		)
	})

	test('rejects inline and reusable Link Objects with actionable errors', () => {
		expect(() => compose([linkObjectFragment('operation-response')])).toThrow(
			'uses unsupported Link Objects at paths./api/v1/example.get.responses.200.links'
		)
		expect(() => compose([linkObjectFragment('component-response')])).toThrow(
			'uses unsupported Link Objects at components.responses.Deployment.links'
		)
		expect(() => compose([linkObjectFragment('components')])).toThrow(
			'uses unsupported Link Objects at components.links'
		)
	})

	test('rejects referenced path items and incompatible parameters reached through references', () => {
		expect(() => compose([referencedPathItemFragment()])).toThrow(
			'uses unsupported Path Item $ref at paths./api/v1/referenced-jobs.$ref'
		)
		expect(() => compose([referencedParameterCollisionFragment()])).toThrow(
			'parameter collision at paths./api/v1/example.get.parameters.query:limit'
		)
	})

	test('rejects incompatible paths, path parameters, schemas, and component parameters', () => {
		const firstPath = document({ pathItem: { summary: 'first' } })
		const secondPath = document({ operationId: 'otherGet', pathItem: { summary: 'second' } })
		delete (secondPath.paths['/api/v1/example'] as Record<string, unknown>).get
		expect(() => compose([fragment('example', firstPath), fragment('other', secondPath)])).toThrow(
			'path collision at paths./api/v1/example.summary'
		)

		expect(() =>
			compose([
				fragment('example', document({ path: '/api/v1/users/{id}', operationId: 'exampleGet' })),
				fragment('other', document({ path: '/api/v1/users/{userId}', operationId: 'otherGet' }))
			])
		).toThrow('path collision between templates')

		const first = document({
			pathItem: {
				parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer' } }]
			}
		})
		const second = document({
			operationId: 'otherGet',
			pathItem: {
				parameters: [{ in: 'query', name: 'limit', schema: { type: 'string' } }]
			}
		})
		delete (second.paths['/api/v1/example'] as Record<string, unknown>).get
		expect(() => compose([fragment('example', first), fragment('other', second)])).toThrow(
			'parameter collision at paths./api/v1/example.parameters.query:limit'
		)

		const headerParameters = document({
			pathItem: {
				parameters: [
					{ in: 'header', name: 'X-Request-ID', schema: { type: 'string' } },
					{ in: 'header', name: 'x-request-id', schema: { type: 'number' } }
				]
			}
		})
		expect(() => compose([fragment('example', headerParameters)])).toThrow(
			'parameter collision at paths./api/v1/example.parameters.header:x-request-id'
		)

		const withComponents = (owner: string, schemaType: string, parameterType: string) => {
			const value = document({
				path: `/api/v1/${owner}`,
				operationId: `${owner}Get`
			})
			value.components = {
				schemas: { Shared: { type: schemaType } },
				parameters: {
					Shared: { in: 'query', name: 'shared', schema: { type: parameterType } }
				}
			}
			return fragment(owner, value)
		}
		expect(() =>
			compose([
				withComponents('example', 'string', 'string'),
				withComponents('other', 'number', 'string')
			])
		).toThrow('component collision at components.schemas.Shared')
		expect(() =>
			compose([
				withComponents('example', 'string', 'string'),
				withComponents('other', 'string', 'number')
			])
		).toThrow('component collision at components.parameters.Shared')
	})

	test('the generated command rejects operation, method, parameter, and component collisions', async () => {
		const composeGenerated = await loadGeneratedComposer()
		const duplicateOperation = {
			owner: 'other',
			operationIdPrefix: 'example',
			document: document({ path: '/api/v1/other', operationId: 'exampleGet' })
		}
		expect(() => composeGenerated([fragment('example', document()), duplicateOperation])).toThrow(
			'duplicate operationId "exampleGet"'
		)
		expect(() =>
			composeGenerated([
				fragment('example', document()),
				fragment('other', document({ operationId: 'otherGet' }))
			])
		).toThrow('method collision at paths./api/v1/example.get')

		const first = document({
			pathItem: { parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer' } }] }
		})
		const second = document({
			operationId: 'otherGet',
			pathItem: { parameters: [{ in: 'query', name: 'limit', schema: { type: 'string' } }] }
		})
		delete (second.paths['/api/v1/example'] as Record<string, unknown>).get
		expect(() => composeGenerated([fragment('example', first), fragment('other', second)])).toThrow(
			'parameter collision at paths./api/v1/example.parameters.query:limit'
		)

		const firstComponent = document()
		firstComponent.components = { schemas: { Shared: { type: 'string' } } }
		const secondComponent = document({ path: '/api/v1/other', operationId: 'otherGet' })
		secondComponent.components = { schemas: { Shared: { type: 'number' } } }
		expect(() =>
			composeGenerated([fragment('example', firstComponent), fragment('other', secondComponent)])
		).toThrow('component collision at components.schemas.Shared')

		expect(() =>
			composeGenerated([
				fragment('example', document({ path: '/api/v1/users/{id}', operationId: 'exampleGet' })),
				fragment('other', document({ path: '/api/v1/users/{userId}', operationId: 'otherGet' }))
			])
		).toThrow('path collision between templates')

		const duplicateHeaders = document({
			pathItem: {
				parameters: [
					{ in: 'header', name: 'X-Request-ID', schema: { type: 'string' } },
					{ in: 'header', name: 'x-request-id', schema: { type: 'number' } }
				]
			}
		})
		expect(() => composeGenerated([fragment('example', duplicateHeaders)])).toThrow(
			'parameter collision at paths./api/v1/example.parameters.header:x-request-id'
		)
		expect(() => composeGenerated([callbackFragment('operation')])).toThrow(
			'uses unsupported callbacks at paths./api/v1/jobs.get.callbacks'
		)
		expect(() => composeGenerated([callbackFragment('components')])).toThrow(
			'uses unsupported callbacks at components.callbacks'
		)
		expect(() => composeGenerated([deploymentServerFragment('path')])).toThrow(
			'must not declare servers at paths./api/v1/example.servers'
		)
		expect(() => composeGenerated([deploymentServerFragment('operation')])).toThrow(
			'must not declare servers at paths./api/v1/example.get.servers'
		)
		expect(() => composeGenerated([linkObjectFragment('operation-response')])).toThrow(
			'uses unsupported Link Objects at paths./api/v1/example.get.responses.200.links'
		)
		expect(() => composeGenerated([linkObjectFragment('component-response')])).toThrow(
			'uses unsupported Link Objects at components.responses.Deployment.links'
		)
		expect(() => composeGenerated([linkObjectFragment('components')])).toThrow(
			'uses unsupported Link Objects at components.links'
		)
		expect(() => composeGenerated([referencedPathItemFragment()])).toThrow(
			'uses unsupported Path Item $ref at paths./api/v1/referenced-jobs.$ref'
		)
		expect(() => composeGenerated([referencedParameterCollisionFragment()])).toThrow(
			'parameter collision at paths./api/v1/example.get.parameters.query:limit'
		)
	})

	test('rejects private paths, deployment servers, missing IDs, and wrong domain prefixes', () => {
		expect(() => compose([fragment('example', document({ path: '/api/auth/session' }))])).toThrow(
			'must use a public /api/v1 path'
		)
		const withServers = document()
		withServers.servers = [{ url: 'https://api.example.test' }]
		expect(() => compose([fragment('example', withServers)])).toThrow('must not declare servers')
		const missingId = document()
		delete (missingId.paths['/api/v1/example']!.get as Record<string, unknown>).operationId
		expect(() => compose([fragment('example', missingId)])).toThrow('missing operationId')
		expect(() => compose([fragment('users', document({ operationId: 'getUsers' }))])).toThrow(
			'must start with "users"'
		)
	})
})

describe('gateway runtime OpenAPI', () => {
	test('adds exactly one configured canonical server and ignores request host headers', async () => {
		const { createGateway } = await loadGeneratedGateway()
		const checked = JSON.parse(entry('apps/api/openapi.json')) as OpenApiDocument
		for (const canonicalApiOrigin of [
			'http://localhost:8786',
			'https://preview-42.api.example.test'
		]) {
			const gateway = createGateway({}, { openApiDocument: checked, canonicalApiOrigin })
			const response = await gateway.fetch(
				new Request('https://attacker.example/api/openapi.json', {
					headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' }
				})
			)
			const runtime = (await response.json()) as OpenApiDocument
			expect(runtime.servers).toEqual([{ url: canonicalApiOrigin }])
			expect(runtime.paths).toEqual(checked.paths)
		}
		expect(checked.servers).toBeUndefined()
	})
})
