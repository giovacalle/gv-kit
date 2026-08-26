export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type OpenApiDocument = {
	openapi: string
	info: { title: string; version: string; description?: string }
	paths: Record<string, JsonObject>
	components?: Record<string, Record<string, JsonValue>>
	servers?: { url: string }[]
	tags?: JsonObject[]
}

export type OpenApiFragment = {
	owner: string
	operationIdPrefix: string
	document: OpenApiDocument
}

const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'])

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

export function createUsersOpenApiFragment({
	project,
	hasAuth
}: {
	project: string
	hasAuth: boolean
}): OpenApiFragment {
	const userSchema: JsonObject = hasAuth
		? {
				type: 'object',
				properties: {
					id: { type: 'string' },
					name: { type: 'string' },
					email: { type: 'string', format: 'email' },
					emailVerified: { type: 'boolean' },
					image: { type: 'string', nullable: true },
					createdAt: {
						anyOf: [{ type: 'string' }, { type: 'string', format: 'date-time' }]
					},
					updatedAt: {
						anyOf: [{ type: 'string' }, { type: 'string', format: 'date-time' }]
					}
				},
				required: ['id', 'name', 'email', 'emailVerified', 'createdAt', 'updatedAt']
			}
		: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					sessionId: { type: 'string' },
					expiresAt: { type: 'string' }
				},
				required: ['id', 'sessionId', 'expiresAt']
			}

	return {
		owner: 'users',
		operationIdPrefix: 'users',
		document: {
			openapi: '3.0.0',
			info: {
				title: `${project}-users`,
				version: '0.0.0',
				description: 'Public users service contract. Compose this fragment at the gateway.'
			},
			components: { schemas: { User: userSchema }, parameters: {} },
			paths: {
				'/api/v1/users/me': {
					get: {
						operationId: 'usersGetMe',
						tags: ['users'],
						summary: 'Return the authenticated user',
						responses: {
							200: {
								description: 'Authenticated user',
								content: {
									'application/json': {
										schema: { $ref: '#/components/schemas/User' }
									}
								}
							},
							401: { description: 'No active session' }
						}
					}
				}
			}
		}
	}
}

export function composeGatewayOpenApi({
	title,
	version,
	fragments
}: {
	title: string
	version: string
	fragments: readonly OpenApiFragment[]
}): OpenApiDocument {
	const paths: Record<string, JsonObject> = {}
	const components: Record<string, Record<string, JsonValue>> = {}
	const operationOwners = new Map<string, string>()

	const pathIdentities = new Map<string, string>()
	for (const fragment of [...fragments].sort((left, right) =>
		compareText(left.owner, right.owner)
	)) {
		validateFragment(fragment, operationOwners)
		mergeComponents(components, fragment)
		mergePaths(paths, pathIdentities, fragment, components.parameters)
	}

	const document: OpenApiDocument = {
		openapi: '3.0.0',
		info: { title, version },
		paths
	}
	if (Object.keys(components).length > 0) document.components = components
	return sortJson(document) as OpenApiDocument
}

function validateFragment(fragment: OpenApiFragment, operationOwners: Map<string, string>): void {
	if (fragment.document.servers !== undefined)
		throw new Error(`OpenAPI fragment "${fragment.owner}" must not declare servers`)
	if (fragment.document.openapi !== '3.0.0')
		throw new Error(
			`OpenAPI fragment "${fragment.owner}" uses ${fragment.document.openapi}; expected 3.0.0`
		)
	if (Object.keys(fragment.document.components?.callbacks ?? {}).length > 0)
		throw new Error(
			`OpenAPI fragment "${fragment.owner}" uses unsupported callbacks at components.callbacks`
		)
	if (Object.keys(fragment.document.components?.links ?? {}).length > 0)
		throw new Error(
			`OpenAPI fragment "${fragment.owner}" uses unsupported Link Objects at components.links`
		)
	for (const [name, response] of Object.entries(fragment.document.components?.responses ?? {})) {
		rejectResponseLinks(response, `components.responses.${name}`, fragment.owner)
	}

	for (const [path, pathItem] of Object.entries(fragment.document.paths)) {
		if (path === '/api/auth' || path.startsWith('/api/auth/') || !path.startsWith('/api/v1/'))
			throw new Error(
				`OpenAPI fragment "${fragment.owner}" path "${path}" must use a public /api/v1 path`
			)
		if (pathItem.$ref !== undefined)
			throw new Error(
				`OpenAPI fragment "${fragment.owner}" uses unsupported Path Item $ref at paths.${path}.$ref`
			)
		if (pathItem.servers !== undefined)
			throw new Error(
				`OpenAPI fragment "${fragment.owner}" must not declare servers at paths.${path}.servers`
			)
		validateParameterList(pathItem.parameters, `paths.${path}.parameters`, fragment)
		for (const [method, value] of Object.entries(pathItem)) {
			if (!HTTP_METHODS.has(method)) continue
			if (!isJsonObject(value))
				throw new Error(
					`OpenAPI fragment "${fragment.owner}" has an invalid operation at ${path}.${method}`
				)
			if (value.callbacks !== undefined)
				throw new Error(
					`OpenAPI fragment "${fragment.owner}" uses unsupported callbacks at paths.${path}.${method}.callbacks`
				)
			if (value.servers !== undefined)
				throw new Error(
					`OpenAPI fragment "${fragment.owner}" must not declare servers at paths.${path}.${method}.servers`
				)
			const operationId = value.operationId
			if (typeof operationId !== 'string' || operationId.length === 0)
				throw new Error(
					`OpenAPI fragment "${fragment.owner}" is missing operationId at ${path}.${method}`
				)
			if (!operationId.startsWith(fragment.operationIdPrefix))
				throw new Error(
					`OpenAPI operationId "${operationId}" at ${path}.${method} must start with "${fragment.operationIdPrefix}"`
				)
			const firstOwner = operationOwners.get(operationId)
			if (firstOwner)
				throw new Error(
					`duplicate operationId "${operationId}" in fragments "${firstOwner}" and "${fragment.owner}"`
				)
			operationOwners.set(operationId, fragment.owner)
			validateParameterList(value.parameters, `paths.${path}.${method}.parameters`, fragment)
			if (isJsonObject(value.responses)) {
				for (const [status, response] of Object.entries(value.responses)) {
					rejectResponseLinks(
						response,
						`paths.${path}.${method}.responses.${status}`,
						fragment.owner
					)
				}
			}
		}
	}
}

function rejectResponseLinks(response: JsonValue, location: string, owner: string): void {
	if (!isJsonObject(response) || response.links === undefined) return
	throw new Error(`OpenAPI fragment "${owner}" uses unsupported Link Objects at ${location}.links`)
}

function validateParameterList(
	value: JsonValue | undefined,
	location: string,
	fragment: OpenApiFragment
): void {
	if (value === undefined) return
	if (!Array.isArray(value))
		throw new Error(`OpenAPI fragment "${fragment.owner}" has invalid parameters at ${location}`)
	const parameters = new Map<string, JsonValue>()
	for (const [index, parameter] of value.entries()) {
		const descriptor = parameterDescriptor(
			parameter,
			fragment.document.components?.parameters,
			`${location}[${index}]`,
			fragment.owner
		)
		if (!descriptor.identity) continue
		const existing = parameters.get(descriptor.identity)
		if (existing && !jsonEqual(existing, descriptor.definition))
			throw new Error(
				`parameter collision at ${location}.${descriptor.identity} in fragment "${fragment.owner}"`
			)
		parameters.set(descriptor.identity, descriptor.definition)
	}
}

function mergePaths(
	target: Record<string, JsonObject>,
	pathIdentities: Map<string, string>,
	fragment: OpenApiFragment,
	parameterComponents: Record<string, JsonValue> | undefined
): void {
	for (const [path, incoming] of Object.entries(fragment.document.paths)) {
		const identity = path.replaceAll(/\{[^}]+\}/g, '{}')
		const equivalentPath = pathIdentities.get(identity)
		if (equivalentPath && equivalentPath !== path)
			throw new Error(`path collision between templates "${equivalentPath}" and "${path}"`)
		pathIdentities.set(identity, path)
		const existing = target[path]
		if (!existing) {
			target[path] = structuredClone(incoming)
			continue
		}
		for (const [field, value] of Object.entries(incoming)) {
			const location = `paths.${path}.${field}`
			const current = existing[field]
			if (current === undefined) {
				existing[field] = structuredClone(value)
				continue
			}
			if (HTTP_METHODS.has(field)) throw new Error(`method collision at ${location}`)
			if (field === 'parameters') {
				existing[field] = mergeParameters(
					current,
					value,
					location,
					parameterComponents,
					fragment.owner
				)
				continue
			}
			if (!jsonEqual(current, value)) throw new Error(`path collision at ${location}`)
		}
	}
}

function mergeParameters(
	existing: JsonValue,
	incoming: JsonValue,
	location: string,
	parameterComponents: Record<string, JsonValue> | undefined,
	owner: string
): JsonValue[] {
	if (!Array.isArray(existing) || !Array.isArray(incoming))
		throw new Error(`parameter collision at ${location}`)
	const merged = structuredClone(existing)
	const byIdentity = new Map<string, JsonValue>()
	for (const [index, parameter] of merged.entries()) {
		const descriptor = parameterDescriptor(
			parameter,
			parameterComponents,
			`${location}[${index}]`,
			owner
		)
		if (descriptor.identity) byIdentity.set(descriptor.identity, descriptor.definition)
	}
	for (const [index, parameter] of incoming.entries()) {
		const descriptor = parameterDescriptor(
			parameter,
			parameterComponents,
			`${location}[${merged.length + index}]`,
			owner
		)
		if (!descriptor.identity) {
			if (!merged.some((candidate) => jsonEqual(candidate, parameter)))
				merged.push(structuredClone(parameter))
			continue
		}
		const current = byIdentity.get(descriptor.identity)
		if (current && !jsonEqual(current, descriptor.definition))
			throw new Error(`parameter collision at ${location}.${descriptor.identity}`)
		if (!current) {
			merged.push(structuredClone(parameter))
			byIdentity.set(descriptor.identity, descriptor.definition)
		}
	}
	return merged
}

function mergeComponents(
	target: Record<string, Record<string, JsonValue>>,
	fragment: OpenApiFragment
): void {
	for (const [group, entries] of Object.entries(fragment.document.components ?? {})) {
		const targetGroup = (target[group] ??= {})
		for (const [name, value] of Object.entries(entries)) {
			const existing = targetGroup[name]
			if (existing !== undefined && !jsonEqual(existing, value))
				throw new Error(`component collision at components.${group}.${name}`)
			if (existing === undefined) targetGroup[name] = structuredClone(value)
		}
	}
}

function parameterDescriptor(
	value: JsonValue,
	parameterComponents: Record<string, JsonValue> | undefined,
	location: string,
	owner: string
): { definition: JsonValue; identity: string | undefined } {
	const definition =
		isJsonObject(value) && typeof value.$ref === 'string'
			? resolveParameterReference(value.$ref, parameterComponents, location, owner, new Set())
			: value
	return { definition, identity: directParameterIdentity(definition) }
}

function resolveParameterReference(
	reference: string,
	parameterComponents: Record<string, JsonValue> | undefined,
	location: string,
	owner: string,
	seen: Set<string>
): JsonValue {
	const prefix = '#/components/parameters/'
	const encodedName = reference.startsWith(prefix) ? reference.slice(prefix.length) : ''
	if (!encodedName || encodedName.includes('/') || /~(?:[^01]|$)/.test(encodedName))
		throw new Error(
			`OpenAPI fragment "${owner}" uses unsupported parameter reference "${reference}" at ${location}`
		)
	if (seen.has(reference))
		throw new Error(
			`OpenAPI fragment "${owner}" has cyclic parameter reference "${reference}" at ${location}`
		)
	const name = encodedName.replaceAll('~1', '/').replaceAll('~0', '~')
	const definition = parameterComponents?.[name]
	if (definition === undefined)
		throw new Error(
			`OpenAPI fragment "${owner}" cannot resolve parameter reference "${reference}" at ${location}`
		)
	if (isJsonObject(definition) && typeof definition.$ref === 'string') {
		return resolveParameterReference(
			definition.$ref,
			parameterComponents,
			location,
			owner,
			new Set([...seen, reference])
		)
	}
	if (!directParameterIdentity(definition))
		throw new Error(
			`OpenAPI fragment "${owner}" cannot determine parameter identity for "${reference}" at ${location}`
		)
	return definition
}

function directParameterIdentity(value: JsonValue): string | undefined {
	if (!isJsonObject(value) || typeof value.in !== 'string' || typeof value.name !== 'string') {
		return undefined
	}
	const name = value.in === 'header' ? value.name.toLowerCase() : value.name
	return `${value.in}:${name}`
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
	return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right))
}

export function sortJson(value: JsonValue | OpenApiDocument): JsonValue {
	if (Array.isArray(value)) return value.map((entry) => sortJson(entry))
	if (typeof value !== 'object' || value === null) return value
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => compareText(left, right))
			.map(([key, entry]) => [key, sortJson(entry as JsonValue)])
	)
}

export function stringifyOpenApi(document: OpenApiDocument): string {
	return `${JSON.stringify(sortJson(document), null, 2)}\n`
}
