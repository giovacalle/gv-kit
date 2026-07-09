import { z } from 'zod'

export const FrontendChoice = z.literal('sveltekit')
export const BackendChoice = z.enum(['hono', 'inside-frontend'])
export const BackendRuntimeChoice = z.enum(['promise', 'effect'])
export const I18nChoice = z.enum(['paraglide', 'skip'])
export const MonitoringChoice = z.enum(['umami', 'posthog'])
export const DbChoice = z.enum(['postgres', 'sqlite'])
export const ApiClientChoice = z.enum(['hey-api', 'skip'])
export const AuthChoice = z.enum(['emailOTP', 'google'])
export const EmailChoice = z.enum(['resend', 'notifuse', 'skip'])
export const AiToolingChoice = z.enum(['claude', 'codex', 'opencode'])
export const DeployChoice = z.enum(['cf-workers', 'docker', 'skip'])

export const Choices = z.object({
	name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'kebab-case, lowercase, start with letter'),
	frontend: FrontendChoice,
	backend: BackendChoice,
	backendRuntime: BackendRuntimeChoice.default('promise'),
	i18n: I18nChoice,
	monitoring: z.array(MonitoringChoice),
	db: DbChoice,
	apiClient: ApiClientChoice,
	auth: z.array(AuthChoice),
	email: EmailChoice,
	aiTooling: z.array(AiToolingChoice),
	deploy: DeployChoice
})

export const GvKitConfig = z
	.object({
		configVersion: z.literal(1),
		choices: Choices
	})
	.superRefine((cfg, ctx) => {
		if (cfg.choices.backend === 'inside-frontend' && cfg.choices.apiClient !== 'skip') {
			ctx.addIssue({
				code: 'custom',
				message: 'apiClient must be "skip" when backend is "inside-frontend"',
				path: ['choices', 'apiClient']
			})
		}
		if (cfg.choices.backend === 'inside-frontend' && cfg.choices.backendRuntime === 'effect') {
			ctx.addIssue({
				code: 'custom',
				message: 'backendRuntime="effect" requires backend="hono"',
				path: ['choices', 'backendRuntime']
			})
		}
		if (cfg.choices.auth.includes('emailOTP') && cfg.choices.email === 'skip') {
			ctx.addIssue({
				code: 'custom',
				message: 'emailOTP requires an email provider (resend or notifuse)',
				path: ['choices', 'email']
			})
		}
	})

export type GvKitConfig = z.infer<typeof GvKitConfig>
export type Choices = z.infer<typeof Choices>
