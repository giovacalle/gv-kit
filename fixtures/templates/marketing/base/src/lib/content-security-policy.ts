interface MonitoringPolicyOptions {
	umamiScript?: string
	posthogHost?: string
	posthogKey?: string
}

function isPosthogCloud(hostname: string): boolean {
	return hostname === 'posthog.com' || hostname.endsWith('.posthog.com')
}

export function buildContentSecurityPolicy({
	umamiScript,
	posthogHost,
	posthogKey
}: MonitoringPolicyOptions = {}): string {
	const monitoringOrigins = new Set<string>()
	const scriptSources = new Set<string>()
	const connectSources = new Set<string>()
	const workerSources = new Set(["'self'", 'blob:'])

	if (umamiScript) monitoringOrigins.add(new URL(umamiScript).origin)
	if (posthogHost && posthogKey) {
		const posthogUrl = new URL(posthogHost)
		monitoringOrigins.add(posthogUrl.origin)
		workerSources.add('data:')
		if (isPosthogCloud(posthogUrl.hostname)) {
			scriptSources.add('https://*.posthog.com')
			connectSources.add('https://*.posthog.com')
		}
	}

	for (const origin of monitoringOrigins) {
		scriptSources.add(origin)
		connectSources.add(origin)
	}

	const scripts = [...scriptSources].join(' ')
	const connections = [...connectSources].join(' ')
	const images = [...monitoringOrigins].join(' ')
	return [
		"default-src 'self'",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
		`script-src 'self' 'unsafe-inline'${scripts ? ` ${scripts}` : ''}`,
		"style-src 'self' 'unsafe-inline'",
		`connect-src 'self'${connections ? ` ${connections}` : ''}`,
		`img-src 'self' data:${images ? ` ${images}` : ''}`,
		"font-src 'self' data:",
		`worker-src ${[...workerSources].join(' ')}`
	].join('; ')
}
