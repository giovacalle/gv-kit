import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import type { GvKitConfig } from '../schema/config.js'

const WORKERS_COMPAT_DATE = '2026-04-01'
const DEV_AUTH_URL = 'http://127.0.0.1:8787'

export function generateFrontendSveltekit(cfg: GvKitConfig): FileEntry[] {
	const hasAuth = cfg.choices.auth.length > 0
	const isInsideFrontend = cfg.choices.backend === 'inside-frontend'

	return renderTemplate({
		tree: 'web',
		flags: {
			auth: hasAuth,
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
}
