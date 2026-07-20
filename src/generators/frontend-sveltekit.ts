import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import type { GvKitConfig } from '../schema/config.js'

const WORKERS_COMPAT_DATE = '2026-04-01'
const DEV_AUTH_URL = 'http://127.0.0.1:8787'

export function generateFrontendSveltekit(cfg: GvKitConfig): FileEntry[] {
	const hasAuth = cfg.choices.auth.length > 0
	const isInsideFrontend = cfg.choices.backend === 'inside-frontend'

	const entries = renderTemplate({
		tree: 'web',
		flags: {
			effectBackend: cfg.choices.backendRuntime === 'effect',
			webCompilesI18n:
				cfg.choices.backendRuntime !== 'effect' && cfg.choices.i18n === 'paraglide',
			auth: hasAuth,
			authUiImports: cfg.choices.backendRuntime !== 'effect' || hasAuth,
			layoutServerUsesLocals:
				cfg.choices.backendRuntime !== 'effect' || hasAuth || cfg.choices.i18n === 'paraglide',
			authEmailOtp: cfg.choices.auth.includes('emailOTP'),
			authGoogle: cfg.choices.auth.includes('google'),
			googleHandler:
				cfg.choices.backendRuntime !== 'effect' || cfg.choices.auth.includes('google'),
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

	if (cfg.choices.backendRuntime === 'effect' && cfg.choices.apiClient === 'hey-api') {
		const packageEntry = entries.find((entry) => entry.path === 'apps/web/package.json')
		if (!packageEntry) throw new Error('web template did not emit apps/web/package.json')
		const packageJson = JSON.parse(packageEntry.content) as {
			dependencies: Record<string, string>
		}
		packageJson.dependencies['@tanstack/svelte-query'] = '^5.74.2'
		packageEntry.content = JSON.stringify(packageJson, null, 2) + '\n'

		const usersPage = entries.find((entry) => entry.path === 'apps/web/src/routes/users/+page.svelte')
		if (!usersPage) throw new Error('web template did not emit the users query page')
		usersPage.content = usersPage.content
			.replace('createQuery(() => getUsersMeOptions())', 'createQuery(getUsersMeOptions())')
			.replaceAll('profile.', '$profile.')
		if (!hasAuth) usersPage.content = usersPage.content.replace(
				/\t\t<dl class="grid grid-cols-\[auto_1fr\] gap-x-4 gap-y-1 text-sm">[\s\S]*?\t\t<\/dl>/,
				`\t\t<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
\t\t\t<dt class="text-muted-foreground">ID</dt>
\t\t\t<dd>{$profile.data.id}</dd>
\t\t\t<dt class="text-muted-foreground">Session ID</dt>
\t\t\t<dd>{$profile.data.sessionId}</dd>
\t\t\t<dt class="text-muted-foreground">Expires at</dt>
\t\t\t<dd>{$profile.data.expiresAt}</dd>
\t\t</dl>`
		)
	}

	if (
		cfg.choices.backendRuntime === 'effect' &&
		cfg.choices.auth.includes('google') &&
		!cfg.choices.auth.includes('emailOTP')
	) {
		const loginPage = entries.find(
			(entry) => entry.path === 'apps/web/src/routes/login/+page.svelte'
		)
		if (!loginPage) throw new Error('auth template did not emit the Google login page')
		loginPage.content = loginPage.content
			.replace("\timport Loader2Icon from '@lucide/svelte/icons/loader-2'\n", '')
			.replace("\timport * as Form from '@repo/ui/primitives/form'\n", '')
			.replace("\timport * as Input from '@repo/ui/primitives/input'\n", '')
			.replace("\timport { toast } from 'svelte-sonner'\n", '')
			.replace(
				"\timport { fieldProxy, setError, superForm } from 'sveltekit-superforms'",
				"\timport { superForm } from 'sveltekit-superforms'"
			)
			.replace("\n\timport { goto } from '$app/navigation'", '')
			.replace(
				'\tconst { form: formData, errors, enhance, submitting } = sf',
				'\tconst { form: formData, enhance } = sf'
			)
			.replace("\n\tconst turnstileTokenProxy = fieldProxy(sf, 'turnstileToken')\n", '')
	}

	return entries
}
