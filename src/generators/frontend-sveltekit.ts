import { cloudflareProductionWorkerName } from '../lib/cloudflare-worker-name.js'
import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import { HONO_WORKERS_COMPAT_DATE, WORKERS_COMPAT_DATE } from '../lib/workers.js'
import type { GvKitConfig } from '../schema/config.js'
import {
	CLOUDFLARE_TYPES_BOOTSTRAP_FILE,
	renderCloudflareBootstrapTypes
} from './cloudflare-worker-types.js'
import {
	AUTH_SERVICE,
	HONO_GATEWAY,
	nodeDevelopmentOrigin
} from './hono-topology.js'

const WEB_DEV_AUTH_URL = 'http://localhost:5173'
const ASTRO_OWNED_SEO_ROUTES = new Set([
	'apps/web/src/routes/robots.txt/+server.ts',
	'apps/web/src/routes/sitemap.xml/+server.ts'
])

export function generateFrontendSveltekit(cfg: GvKitConfig): FileEntry[] {
	const hasAuth = cfg.choices.auth.length > 0
	const isInsideFrontend = cfg.choices.backend === 'inside-frontend'
	const isAstroMarketing = cfg.choices.marketing === 'astro'

	const entries = renderTemplate({
		tree: 'web',
		flags: {
			insideFrontendBaseline: isInsideFrontend,
			webCompilesI18n: cfg.choices.i18n === 'paraglide',
			marketingAstro: isAstroMarketing,
			marketingAstroAuth: isAstroMarketing && hasAuth,
			insideWeb: !isAstroMarketing,
			auth: hasAuth,
			authUiImports: hasAuth,
			layoutServerUsesLocals: hasAuth || cfg.choices.i18n === 'paraglide',
			authEmailOtp: cfg.choices.auth.includes('emailOTP'),
			authGoogle: cfg.choices.auth.includes('google'),
			authEmailOtpAndGoogle:
				cfg.choices.auth.includes('emailOTP') && cfg.choices.auth.includes('google'),
			i18nParaglide: cfg.choices.i18n === 'paraglide',
			monitoringPosthog: cfg.choices.monitoring.includes('posthog'),
			monitoringUmami: cfg.choices.monitoring.includes('umami'),
			deployCfWorkers: cfg.choices.deploy === 'cf-workers',
			deployNode: cfg.choices.deploy !== 'cf-workers',
			honoGatewayCfWorkers:
				cfg.choices.backend === 'hono' && cfg.choices.deploy === 'cf-workers',
			insideFrontendCfWorkers:
				isInsideFrontend && cfg.choices.deploy === 'cf-workers',
			insideFrontend: isInsideFrontend,
			insideFrontendAuthEmailOtp:
				isInsideFrontend && hasAuth && cfg.choices.auth.includes('emailOTP'),
			insideFrontendAuthNoEmailOtp:
				isInsideFrontend && hasAuth && !cfg.choices.auth.includes('emailOTP'),
			honoGateway: cfg.choices.backend === 'hono',
			honoGatewayDocker:
				cfg.choices.backend === 'hono' && cfg.choices.deploy === 'docker',
			honoAuth: cfg.choices.backend === 'hono' && hasAuth,
			honoAuthEmailOtp:
				cfg.choices.backend === 'hono' && hasAuth && cfg.choices.auth.includes('emailOTP'),
			honoAuthTransport: cfg.choices.backend === 'hono' && hasAuth,
			apiClientHeyApi: cfg.choices.apiClient === 'hey-api'
		},
		vars: {
			__PROJECT__: cfg.choices.name,
			__CLOUDFLARE_WEB_WORKER__: cloudflareProductionWorkerName({
				project: cfg.choices.name,
				service: 'web'
			}),
			__COMPAT_DATE__:
				cfg.choices.backend === 'hono' ? HONO_WORKERS_COMPAT_DATE : WORKERS_COMPAT_DATE,
			__GATEWAY_TARGET__: HONO_GATEWAY.identity.toUpperCase(),
			__GATEWAY_SERVICE__: cloudflareProductionWorkerName({
				project: cfg.choices.name,
				service: HONO_GATEWAY.transport.cfWorkers.serviceNameSuffix
			}),
			__GATEWAY_URL__: nodeDevelopmentOrigin(HONO_GATEWAY),
			__AUTH_URL__:
				cfg.choices.backend === 'hono' && hasAuth
					? WEB_DEV_AUTH_URL
					: nodeDevelopmentOrigin(AUTH_SERVICE)
		}
	})

	if (cfg.choices.backend === 'hono' && cfg.choices.deploy === 'cf-workers') {
		const wrangler = entries.find((entry) => entry.path === 'apps/web/wrangler.jsonc')
		if (!wrangler) throw new Error('Hono Cloudflare web output requires wrangler.jsonc')
		entries.push({
			path: `apps/web/${CLOUDFLARE_TYPES_BOOTSTRAP_FILE}`,
			content: renderCloudflareBootstrapTypes(wrangler.content)
		})
	}

	// In the split shape Astro is the sole owner of public SEO endpoints.
	// Keep the existing SvelteKit files byte-stable for the integrated shape.
	return isAstroMarketing
		? entries.filter((entry) => !ASTRO_OWNED_SEO_ROUTES.has(entry.path))
		: entries
}
