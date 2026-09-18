export interface HonoServiceTopology {
	identity: string
	workspacePath: `services/${string}`
	packageName: `${string}-worker`
	publicPrefixes: readonly [`/${string}`, ...`/${string}`[]]
	internalTarget: string
	openApi?: {
		fragmentPath: string
		operationIdPrefix: string
	}
	development: {
		hostname: string
		ip: string
		port: number
		inspectorPort: number
	}
	transport: {
		cfWorkers: {
			serviceNameSuffix: string
		}
		docker: {
			serviceName: string
			hostname: string
		}
		node: {
			hostname: string
			targetEnvironmentVariable: string
		}
	}
}

export interface HonoPublicRoute<Identity extends string = string, Target extends string = string> {
	owner: Identity
	prefix: `/${string}`
	target: Target
}

const LEGACY_HONO_PUBLIC_ROUTES = [
	{ owner: 'auth', prefix: '/api/auth', target: 'AUTH' },
	{ owner: 'users', prefix: '/api/v1/users', target: 'USERS' }
] as const satisfies readonly HonoPublicRoute[]

export function defineHonoTopology<const T extends readonly HonoServiceTopology[]>(
	services: T
): T {
	assertUnique(
		services.map((service) => service.identity),
		'service identity'
	)
	assertUnique(
		services.map((service) => service.workspacePath),
		'workspace path'
	)
	assertUnique(
		services.map((service) => service.packageName),
		'package name'
	)
	assertUnique(
		services.map((service) => service.internalTarget),
		'internal target name'
	)
	honoPublicRoutes(services)
	assertUnique(
		services.map((service) => service.development.port),
		'development port'
	)
	return services
}

function assertUnique(values: readonly (number | string)[], label: string): void {
	const seen = new Set<number | string>()
	for (const value of values) {
		if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
		seen.add(value)
	}
}

function assertCanonicalPublicPrefix({
	owner,
	prefix,
	position
}: {
	owner: string
	prefix: string
	position: number
}): void {
	const segments = prefix.split('/').slice(1)
	const hasDotSegment = segments.some((segment) => segment === '.' || segment === '..')
	const canonical = /^\/api(?:\/[A-Za-z0-9._~-]+)+$/.test(prefix) && !hasDotSegment
	if (!canonical) {
		throw new Error(
			`public prefix "${prefix}" at "${owner}" publicPrefixes[${position}] is ambiguous; use a canonical /api path with static segments, single slashes, and no trailing slash, query, fragment, encoding, or dot segments`
		)
	}
	if (prefix === '/api/healthz' || prefix === '/api/openapi.json') {
		throw new Error(
			`public prefix "${prefix}" at "${owner}" publicPrefixes[${position}] conflicts with a gateway-owned operational route`
		)
	}
}

function containsPrefix(parent: string, child: string): boolean {
	return child.startsWith(`${parent}/`)
}

export function honoPublicRoutes<const T extends readonly HonoServiceTopology[]>(
	services: T
): readonly HonoPublicRoute<T[number]['identity'], T[number]['internalTarget']>[] {
	type Route = HonoPublicRoute<T[number]['identity'], T[number]['internalTarget']>
	const routes: Route[] = []
	const owners = new Map<string, { identity: string; position: number }>()

	for (const service of services) {
		for (const [position, prefix] of service.publicPrefixes.entries()) {
			assertCanonicalPublicPrefix({ owner: service.identity, prefix, position })
			const firstOwner = owners.get(prefix)
			if (firstOwner) {
				throw new Error(
					`public prefix "${prefix}" has ambiguous ownership between "${firstOwner.identity}" publicPrefixes[${firstOwner.position}] and "${service.identity}" publicPrefixes[${position}]`
				)
			}
			owners.set(prefix, { identity: service.identity, position })
			const route = {
				owner: service.identity,
				prefix,
				target: service.internalTarget
			} as Route
			const ancestorIndex = routes.findIndex((candidate) =>
				containsPrefix(candidate.prefix, route.prefix)
			)
			if (ancestorIndex === -1) routes.push(route)
			else routes.splice(ancestorIndex, 0, route)
		}
	}

	return routes
}

export const HONO_GATEWAY = {
	identity: 'gateway',
	workspacePath: 'apps/api',
	packageName: 'api-gateway',
	development: {
		hostname: 'localhost',
		ip: '127.0.0.1',
		port: 8786,
		inspectorPort: 9228
	},
	transport: {
		cfWorkers: {
			serviceNameSuffix: 'api'
		},
		docker: {
			serviceName: 'gateway',
			hostname: 'gateway'
		},
		node: {
			hostname: '127.0.0.1',
			targetEnvironmentVariable: 'GATEWAY_URL'
		}
	}
} as const

export const HONO_SERVICES = defineHonoTopology([
	{
		identity: 'auth',
		workspacePath: 'services/auth',
		packageName: 'auth-worker',
		publicPrefixes: ['/api/auth'],
		internalTarget: 'AUTH',
		development: {
			hostname: 'localhost',
			ip: '127.0.0.1',
			port: 8787,
			inspectorPort: 9229
		},
		transport: {
			cfWorkers: {
				serviceNameSuffix: 'auth'
			},
			docker: {
				serviceName: 'auth',
				hostname: 'auth'
			},
			node: {
				hostname: '127.0.0.1',
				targetEnvironmentVariable: 'AUTH_URL'
			}
		}
	},
	{
		identity: 'users',
		workspacePath: 'services/users',
		packageName: 'users-worker',
		publicPrefixes: ['/api/v1/users'],
		internalTarget: 'USERS',
		openApi: {
			fragmentPath: 'openapi.json',
			operationIdPrefix: 'users'
		},
		development: {
			hostname: 'localhost',
			ip: '127.0.0.1',
			port: 8788,
			inspectorPort: 9230
		},
		transport: {
			cfWorkers: {
				serviceNameSuffix: 'users'
			},
			docker: {
				serviceName: 'users',
				hostname: 'users'
			},
			node: {
				hostname: '127.0.0.1',
				targetEnvironmentVariable: 'USERS_URL'
			}
		}
	}
] as const)

export type HonoServiceIdentity = (typeof HONO_SERVICES)[number]['identity']

export const HONO_PUBLIC_ROUTES = honoPublicRoutes(HONO_SERVICES)

export function hasLegacyHonoPublicRouteTable(
	services: readonly HonoServiceTopology[]
): boolean {
	const routes = honoPublicRoutes(services)
	return (
		routes.length === LEGACY_HONO_PUBLIC_ROUTES.length &&
		routes.every((route, index) => {
			const legacyRoute = LEGACY_HONO_PUBLIC_ROUTES[index]
			return (
				route.owner === legacyRoute?.owner &&
				route.prefix === legacyRoute?.prefix &&
				route.target === legacyRoute?.target
			)
		})
	)
}

export const AUTH_SERVICE = HONO_SERVICES[0]
export const USERS_SERVICE = HONO_SERVICES[1]

export function honoPackageIdentity(
	project: string,
	deployable: { packageName: string }
): string {
	return `@${project}/${deployable.packageName}`
}

export function honoServiceName(
	project: string,
	deployable: { transport: { cfWorkers: { serviceNameSuffix: string } } }
): string {
	return `${project}-${deployable.transport.cfWorkers.serviceNameSuffix}`
}

export function honoServicePath(service: HonoServiceTopology, relativePath: string): string {
	return `${service.workspacePath}/${relativePath}`
}

export function developmentOrigin(deployable: {
	development: { hostname: string; port: number }
}): string {
	return `http://${deployable.development.hostname}:${deployable.development.port}`
}

export function nodeDevelopmentOrigin(deployable: {
	development: { port: number }
	transport: { node: { hostname: string } }
}): string {
	return `http://${deployable.transport.node.hostname}:${deployable.development.port}`
}

export function dockerServiceOrigin(deployable: {
	development: { port: number }
	transport: { docker: { hostname: string } }
}): string {
	return `http://${deployable.transport.docker.hostname}:${deployable.development.port}`
}
