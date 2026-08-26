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
	assertUnique(
		services.flatMap((service) => service.publicPrefixes),
		'public prefix'
	)
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
