import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import { WORKERS_COMPAT_DATE } from '../lib/workers.js'
import type { GvKitConfig } from '../schema/config.js'

const DEV_AUTH_URL = 'http://127.0.0.1:8787'
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
			insideFrontend: isInsideFrontend,
			insideFrontendAuth: isInsideFrontend && hasAuth,
			apiClientHeyApi: cfg.choices.apiClient === 'hey-api'
		},
		vars: {
			__PROJECT__: cfg.choices.name,
			__COMPAT_DATE__: WORKERS_COMPAT_DATE,
			__AUTH_URL__: DEV_AUTH_URL
		}
	})

	// In the split shape Astro is the sole owner of public SEO endpoints.
	// Keep the existing SvelteKit files byte-stable for the integrated shape.
	return isAstroMarketing
		? entries.filter((entry) => !ASTRO_OWNED_SEO_ROUTES.has(entry.path))
		: entries
}
