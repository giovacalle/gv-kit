import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'
import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler, resolver, validator } from 'hono-openapi'

const ParamSchema = Schema.Struct({
	id: Schema.String.pipe(Schema.minLength(2))
})

const QuerySchema = Schema.Struct({
	includeBody: Schema.optional(Schema.Literal('true', 'false'))
})

const DateTimeFromString = Schema.DateFromString.annotations({
	identifier: 'ContractDateTime',
	jsonSchema: { type: 'string', format: 'date-time' }
})

const BodySchema = Schema.Struct({
	title: Schema.String,
	body: Schema.String,
	summary: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
	occurredAt: DateTimeFromString
})

const SuccessSchema = Schema.Struct({
	id: Schema.String,
	includeBody: Schema.Boolean,
	summary: Schema.NullOr(Schema.String),
	occurredAt: DateTimeFromString
})

const ContractErrorSchema = Schema.Struct({
	_tag: Schema.Literal('ContractError'),
	message: Schema.String,
	code: Schema.Literal('INVALID_CONTRACT')
})

const ParamStandard = Schema.standardSchemaV1(ParamSchema)
const QueryStandard = Schema.standardSchemaV1(QuerySchema)
const BodyStandard = Schema.standardSchemaV1(BodySchema)
const SuccessStandard = Schema.standardSchemaV1(SuccessSchema)
const ContractErrorStandard = Schema.standardSchemaV1(ContractErrorSchema)

const invalidContract = {
	_tag: 'ContractError',
	message: 'Invalid request',
	code: 'INVALID_CONTRACT'
} as const

type ContractPost = {
	id: string
	title: string
	body: string
	summary: string | null
	occurredAt: Date
}

type ContractRepository = {
	write(post: ContractPost): Promise<void>
	read(id: string): Promise<ContractPost | undefined>
}

class InMemoryContractRepository implements ContractRepository {
	readonly operations: string[] = []
	readonly #posts = new Map<string, ContractPost>()

	async write(post: ContractPost): Promise<void> {
		this.operations.push(`write:${post.id}`)
		this.#posts.set(post.id, post)
	}

	async read(id: string): Promise<ContractPost | undefined> {
		this.operations.push(`read:${id}`)
		return this.#posts.get(id)
	}
}

function contractHarness(repository: ContractRepository = new InMemoryContractRepository()) {
	const app = new Hono()

	app.post(
		'/contract/posts/:id',
		validator('param', ParamStandard, (result, c) => {
			if (!result.success) return c.json(invalidContract, 400)
		}),
		validator('query', QueryStandard, (result, c) => {
			if (!result.success) return c.json(invalidContract, 400)
		}),
		validator('json', BodyStandard, (result, c) => {
			if (!result.success) return c.json(invalidContract, 400)
		}),
		describeRoute({
			operationId: 'exerciseEffectContract',
			responses: {
				200: {
					description: 'Validated contract',
					content: { 'application/json': { schema: resolver(SuccessStandard) } }
				},
				400: {
					description: 'Typed contract failure',
					content: { 'application/json': { schema: resolver(ContractErrorStandard) } }
				}
			}
		}),
		async (c) => {
			const params = c.req.valid('param')
			const query = c.req.valid('query')
			const body = c.req.valid('json')
			await repository.write({
				id: params.id,
				title: body.title,
				body: body.body,
				summary: body.summary ?? null,
				occurredAt: body.occurredAt
			})

			const persisted = await repository.read(params.id)
			if (!persisted) throw new Error('contract post was not persisted')

			return c.json({
				id: persisted.id,
				includeBody: query.includeBody === 'true',
				summary: persisted.summary,
				occurredAt: persisted.occurredAt.toISOString()
			})
		}
	)

	app.get(
		'/openapi.json',
		openAPIRouteHandler(app, {
			documentation: { info: { title: 'Effect contract harness', version: '0.0.0' } }
		})
	)

	return app
}

describe('test-only Effect contract harness', () => {
	test('validates params, query, body, nullable fields, and date-time values at runtime', async () => {
		const repository = new InMemoryContractRepository()
		const response = await contractHarness(repository).request(
			'/contract/posts/post-1?includeBody=true',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Contract',
					body: 'Harness only',
					summary: null,
					occurredAt: '2026-07-17T00:00:00.000Z'
				})
			}
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			id: 'post-1',
			includeBody: true,
			summary: null,
			occurredAt: '2026-07-17T00:00:00.000Z'
		})
		expect(repository.operations).toEqual(['write:post-1', 'read:post-1'])
	})

	test('maps invalid params, query, and body to the declared typed error', async () => {
		const invalidRequests = [
			{
				url: '/contract/posts/x?includeBody=true',
				body: {
					title: 'Contract',
					body: 'Harness only',
					occurredAt: '2026-07-17T00:00:00.000Z'
				}
			},
			{
				url: '/contract/posts/post-1?includeBody=maybe',
				body: {
					title: 'Contract',
					body: 'Harness only',
					occurredAt: '2026-07-17T00:00:00.000Z'
				}
			},
			{
				url: '/contract/posts/post-1?includeBody=true',
				body: { title: 'Contract', body: 'Harness only', occurredAt: 42 }
			}
		]

		for (const request of invalidRequests) {
			const repository = new InMemoryContractRepository()
			const response = await contractHarness(repository).request(request.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(request.body)
			})

			const responseBody = await response.json()
			const schemaResult = await ContractErrorStandard['~standard'].validate(responseBody)

			expect(response.status).toBe(400)
			expect(responseBody).toEqual(invalidContract)
			expect(schemaResult).toEqual({ value: invalidContract })
			expect(repository.operations).toEqual([])
		}
	})

	test('retains OpenAPI coverage for params, query, body, nullable/date-time fields, and errors', async () => {
		const response = await contractHarness().request('/openapi.json')
		const document = (await response.json()) as {
			paths: Record<string, unknown>
		}
		const contract = JSON.stringify(document.paths['/contract/posts/{id}'])

		expect(response.status).toBe(200)
		expect(contract).toContain('exerciseEffectContract')
		expect(contract).toContain('includeBody')
		expect(contract).toContain('requestBody')
		expect(contract).toContain('summary')
		expect(contract).toContain('date-time')
		expect(contract).toContain('ContractError')
		expect(contract).toContain('INVALID_CONTRACT')
	})
})
