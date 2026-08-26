import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import { HONO_WORKERS_COMPAT_DATE, WORKERS_COMPAT_DATE } from '../lib/workers.js'
import type { GvKitConfig } from '../schema/config.js'

/** Generate the optional static Astro marketing surface under `apps/marketing`. */
export function generateMarketingAstro(cfg: GvKitConfig): FileEntry[] {
	if (cfg.choices.marketing !== 'astro') return []

	return renderTemplate({
		tree: 'marketing',
		flags: {
			i18nParaglide: cfg.choices.i18n === 'paraglide',
			monitoringUmami: cfg.choices.monitoring.includes('umami'),
			monitoringPosthog: cfg.choices.monitoring.includes('posthog'),
			deployCfWorkers: cfg.choices.deploy === 'cf-workers',
			deployDocker: cfg.choices.deploy === 'docker',
			honoCfWorkers:
				cfg.choices.backend === 'hono' && cfg.choices.deploy === 'cf-workers'
		},
		vars: {
			__PROJECT__: cfg.choices.name,
			__COMPAT_DATE__:
				cfg.choices.backend === 'hono' ? HONO_WORKERS_COMPAT_DATE : WORKERS_COMPAT_DATE
		}
	})
}
