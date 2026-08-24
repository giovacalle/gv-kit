import { z } from 'zod'

export const FrontendChoice = z.literal('sveltekit')
export const MarketingChoice = z.enum(['astro', 'inside-web'])
export const BackendChoice = z.enum(['hono', 'inside-frontend'])
export const I18nChoice = z.enum(['paraglide', 'skip'])
export const MonitoringChoice = z.enum(['umami', 'posthog'])
export const DbChoice = z.enum(['postgres', 'sqlite'])
export const ApiClientChoice = z.enum(['hey-api', 'skip'])
export const AuthChoice = z.enum(['emailOTP', 'google'])
export const EmailChoice = z.enum(['resend', 'notifuse', 'skip'])
export const AiToolingChoice = z.enum(['claude', 'codex', 'opencode'])
export const DeployChoice = z.enum(['cf-workers', 'docker', 'skip'])

export const Choices = z
	.object({
		name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'kebab-case, lowercase, start with letter'),
		frontend: FrontendChoice,
		marketing: MarketingChoice,
		backend: BackendChoice,
		i18n: I18nChoice,
		monitoring: z.array(MonitoringChoice),
		db: DbChoice,
		apiClient: ApiClientChoice,
		auth: z.array(AuthChoice),
		email: EmailChoice,
		aiTooling: z.array(AiToolingChoice),
		deploy: DeployChoice
	})
	.strict()

const LegacyChoices = Choices.omit({ marketing: true })

const GvKitConfigV1 = z
	.object({
		configVersion: z.literal(1),
		choices: LegacyChoices
	})
	.strict()

const GvKitConfigV2Input = z
	.object({
		configVersion: z.literal(2),
		choices: Choices
	})
	.strict()

/**
 * Accept strict v1/v2 serialized configs and always return the normalized v2
 * contract used by generators. A v1 file predates the project-shape choice,
 * so its existing SvelteKit public surface maps to `marketing="inside-web"`.
 *
 * Keeping the branches strict is important: an old version number paired
 * with a new field must fail instead of silently stripping that field and
 * generating a different topology.
 */
export const GvKitConfig = z
	.discriminatedUnion('configVersion', [GvKitConfigV1, GvKitConfigV2Input])
	.transform((cfg) =>
		cfg.configVersion === 1
			? {
					configVersion: 2 as const,
					choices: { ...cfg.choices, marketing: 'inside-web' as const }
				}
			: cfg
	)
	.superRefine((cfg, ctx) => {
		if (cfg.choices.backend === 'inside-frontend' && cfg.choices.apiClient !== 'skip') {
			ctx.addIssue({
				code: 'custom',
				message: 'apiClient must be "skip" when backend is "inside-frontend"',
				path: ['choices', 'apiClient']
			})
		}
		if (cfg.choices.backend === 'inside-frontend' && cfg.choices.auth.length > 0) {
			ctx.addIssue({
				code: 'custom',
				message: 'auth requires backend "hono"; choose Hono or disable authentication',
				path: ['choices', 'auth']
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
