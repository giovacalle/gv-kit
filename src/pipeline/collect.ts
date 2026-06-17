import { cancel, intro, isCancel, multiselect, select, text } from '@clack/prompts'
import type { Choices } from '../schema/config.js'

function exitIfCancelled<T>(value: T | symbol): asserts value is T {
	if (isCancel(value)) {
		cancel('Cancelled.')
		process.exit(0)
	}
}

/**
 * Interactively collect user choices. Frontend is hard-set to 'sveltekit'.
 * If the user cancels at any prompt, exits cleanly with code 0.
 */
export async function collect(): Promise<{ choices: Choices }> {
	intro('gv-kit')

	const name = await text({
		message: 'Project name',
		placeholder: 'my-app',
		validate: (value) => {
			if (!value || !/^[a-z][a-z0-9-]*$/.test(value)) {
				return 'kebab-case, lowercase, must start with a letter'
			}
			return undefined
		}
	})
	exitIfCancelled(name)

	const backend = await select({
		message: 'Backend',
		options: [
			{ value: 'hono', label: 'Hono on Cloudflare Workers' },
			{ value: 'inside-frontend', label: 'Inside the SvelteKit app (no separate API)' }
		]
	})
	exitIfCancelled(backend)

	const i18n = await select({
		message: 'i18n',
		options: [
			{ value: 'paraglide', label: 'Paraglide' },
			{ value: 'skip', label: 'Skip' }
		]
	})
	exitIfCancelled(i18n)

	const monitoring = await multiselect({
		message: 'Monitoring (select zero or more)',
		options: [
			{ value: 'umami', label: 'Umami' },
			{ value: 'posthog', label: 'PostHog' }
		],
		required: false
	})
	exitIfCancelled(monitoring)

	const db = await select({
		message: 'Database',
		options: [
			{ value: 'postgres', label: 'Postgres (Neon on Cloudflare)' },
			{ value: 'sqlite', label: 'SQLite (D1 on Cloudflare)' }
		]
	})
	exitIfCancelled(db)

	let apiClient: 'hey-api' | 'skip'
	if (backend === 'inside-frontend') {
		apiClient = 'skip'
	} else {
		const choice = await select({
			message: 'API client',
			options: [
				{ value: 'hey-api', label: 'Hey API (OpenAPI + TanStack Query)' },
				{ value: 'skip', label: 'Skip' }
			]
		})
		exitIfCancelled(choice)
		apiClient = choice as 'hey-api' | 'skip'
	}

	const auth = await multiselect({
		message: 'Auth methods (select zero or more)',
		options: [
			{ value: 'emailOTP', label: 'Email OTP' },
			{ value: 'google', label: 'Google OAuth' }
		],
		required: false
	})
	exitIfCancelled(auth)

	const email = await select({
		message: 'Email provider',
		options: [
			{ value: 'resend', label: 'Resend' },
			{ value: 'notifuse', label: 'Notifuse' },
			{ value: 'skip', label: 'Skip' }
		]
	})
	exitIfCancelled(email)

	const aiTooling = await multiselect({
		message: 'AI tooling configs (select zero or more)',
		options: [
			{ value: 'claude', label: 'Claude (CLAUDE.md, .claude/)' },
			{ value: 'codex', label: 'Codex (AGENTS.md)' },
			{ value: 'opencode', label: 'Opencode (AGENTS.md)' }
		],
		required: false
	})
	exitIfCancelled(aiTooling)

	const deploy = await select({
		message: 'Deploy target',
		options: [
			{ value: 'cf-workers', label: 'Cloudflare Workers' },
			{ value: 'docker', label: 'Docker' },
			{ value: 'skip', label: 'Skip' }
		]
	})
	exitIfCancelled(deploy)

	return {
		choices: {
			name: name as string,
			frontend: 'sveltekit',
			backend: backend as 'hono' | 'inside-frontend',
			i18n: i18n as 'paraglide' | 'skip',
			monitoring: monitoring as ('umami' | 'posthog')[],
			db: db as 'postgres' | 'sqlite',
			apiClient,
			auth: auth as ('emailOTP' | 'google')[],
			email: email as 'resend' | 'notifuse' | 'skip',
			aiTooling: aiTooling as ('claude' | 'codex' | 'opencode')[],
			deploy: deploy as 'cf-workers' | 'docker' | 'skip'
		}
	}
}
