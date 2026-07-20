import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/** Generator for `packages/i18n/`. Gated on `i18n === 'paraglide'`. */
export function generateI18n(cfg: GvKitConfig): FileEntry[] {
	if (cfg.choices.i18n !== 'paraglide') return []

	const includeOtp = cfg.choices.auth.includes('emailOTP')
	const includeAuth = cfg.choices.auth.length > 0
	const includeApiClient = cfg.choices.apiClient === 'hey-api'
	const includeMarketing = cfg.choices.marketing === 'astro'

	return [
		{ path: 'packages/i18n/package.json', content: PACKAGE_JSON },
		{ path: 'packages/i18n/tsconfig.json', content: TSCONFIG },
		{ path: 'packages/i18n/.gitignore', content: GITIGNORE },
		{ path: 'packages/i18n/project.inlang/settings.json', content: INLANG_SETTINGS },
		{
			path: 'packages/i18n/messages/en.json',
			content: messagesEn({ includeOtp, includeAuth, includeApiClient, includeMarketing })
		},
		{
			path: 'packages/i18n/messages/it.json',
			content: messagesIt({ includeOtp, includeAuth, includeApiClient, includeMarketing })
		},
		{ path: 'packages/i18n/README.md', content: README }
	]
}

function messagesEn({
	includeOtp,
	includeAuth,
	includeApiClient,
	includeMarketing
}: {
	includeOtp: boolean
	includeAuth: boolean
	includeApiClient: boolean
	includeMarketing: boolean
}): string {
	const base: Record<string, string> = {
		$schema: 'https://inlang.com/schema/inlang-message-format',

		welcome_subject: 'Welcome, {name}',
		welcome_preview: 'Welcome aboard, {name}',
		welcome_title: 'Welcome, {name}',
		welcome_body: "Thanks for signing up — we're glad you're here.",

		landing_hero_title: "You're set.",
		landing_hero_lede: 'The boring parts are wired. Now build the interesting bit.',
		landing_signed_in_badge: 'Signed in',
		landing_continue: 'Continue',

		nav_signin: 'Sign in',
		nav_profile: 'Profile',

		footer_rights: 'All rights reserved.',

		error_title: 'Error {status}',
		error_eyebrow: 'Error {status}',
		error_404_heading: "This page hasn't been built yet.",
		error_403_heading: "You don't have access to this.",
		error_500_heading: 'Something broke. Check the logs.',
		error_back_home: 'Back to home',

		site_description: 'Type-safe full-stack SvelteKit + Hono on Cloudflare Workers'
	}

	if (includeOtp) {
		base.otp_subject = 'Your verification code'
		base.otp_preview = 'Use this code to sign in'
		base.otp_title = 'Verify your sign-in'
		base.otp_intro = 'Enter this code to finish signing in:'
		base.otp_expiry = 'This code expires in {expiryMinutes} minutes.'
	}

	if (includeAuth) {
		base.auth_signin = 'Sign in'
		base.auth_enter_code = 'Enter your code'
		base.auth_otp_lede = "No password. We'll email you a 6-digit code."
		base.auth_otp_sent_to_prefix = 'Sent to'
		base.auth_email_label = 'Email'
		base.auth_send_code = 'Send code'
		base.auth_continue_google = 'Continue with Google'
		base.auth_or = 'or'
		base.auth_otp_code_label = '6-digit code'
		base.auth_verify_signin = 'Verify and sign in'
		base.auth_use_different_email = 'Use a different email'
		base.auth_turnstile_missing =
			'Verification key not configured. Set PUBLIC_TURNSTILE_SITE_KEY before deploy.'

		base.auth_validation_email_invalid = 'Enter a valid email'
		base.auth_validation_otp_invalid = 'Code must be 6 digits'
		base.auth_validation_turnstile_required = 'Please complete the verification'
		base.auth_validation_name_required = 'Name is required'
		base.auth_validation_name_too_long = 'Name is too long'

		base.auth_otp_send_failed = 'Could not send code. Please try again.'
		base.auth_otp_send_success = 'Code sent. Check your inbox.'
		base.auth_otp_too_many_requests = 'Too many requests. Try again in a minute.'
		base.auth_otp_invalid_code = 'Invalid or expired code'
		base.auth_verification_failed = 'Verification failed — please try again'

		base.account_update_failed = 'Could not update profile.'
		base.account_update_success = 'Profile updated.'

		base.me_title = 'Signed in'
		base.me_email_label = 'Email'
		base.me_name_label = 'Name'
		base.me_manage_account = 'Manage account'

		base.account_title = 'Account'
		base.account_lede = 'Manage your profile and session.'
		base.account_profile_title = 'Profile'
		base.account_profile_desc = 'Your display name. Email is set at sign-in time.'
		base.account_name_label = 'Name'
		base.account_email_label = 'Email'
		base.account_save = 'Save changes'
		base.account_session_title = 'Session'
		base.account_session_desc = 'Sign out of this browser.'
		base.account_signout = 'Sign out'
		base.account_delete_title = 'Delete account'
		base.account_delete_desc =
			'Permanently remove your account and all associated data. This cannot be undone.'
		base.account_delete_button = 'Delete account'
		base.account_delete_confirm_title = 'Delete account?'
		base.account_delete_confirm_desc =
			'This will permanently delete your account and all associated data. You cannot recover it once deleted.'
		base.account_cancel = 'Cancel'
		base.account_delete_yes = 'Yes, delete'
		base.account_delete_failed = 'Could not delete account.'
		base.account_delete_success = 'Account deleted.'
	}

	if (includeApiClient) {
		base.users_title = 'Current user'
		base.users_lede = 'Fetched client-side through the generated client, cached by TanStack Query.'
		base.users_loading = 'Loading…'
		base.users_name_label = 'Name'
		base.users_email_label = 'Email'
	}

	if (includeMarketing) {
		base.marketing_title = 'Build the product, not the setup.'
		base.marketing_lede = 'A focused starting point for your public site and application.'
		base.marketing_cta = 'Open the application'
		base.app_home_title = 'Application'
		base.app_home_lede = 'Your application is ready for its first feature.'
	}

	return JSON.stringify(base, null, 2) + '\n'
}

function messagesIt({
	includeOtp,
	includeAuth,
	includeApiClient,
	includeMarketing
}: {
	includeOtp: boolean
	includeAuth: boolean
	includeApiClient: boolean
	includeMarketing: boolean
}): string {
	const base: Record<string, string> = {
		$schema: 'https://inlang.com/schema/inlang-message-format',

		welcome_subject: 'Benvenuto, {name}',
		welcome_preview: 'Benvenuto a bordo, {name}',
		welcome_title: 'Benvenuto, {name}',
		welcome_body: 'Grazie per esserti registrato — siamo felici di averti qui.',

		landing_hero_title: 'Tutto pronto.',
		landing_hero_lede: 'Le parti noiose sono cablate. Ora costruisci quella interessante.',
		landing_signed_in_badge: 'Connesso',
		landing_continue: 'Continua',

		nav_signin: 'Accedi',
		nav_profile: 'Profilo',

		footer_rights: 'Tutti i diritti riservati.',

		error_title: 'Errore {status}',
		error_eyebrow: 'Errore {status}',
		error_404_heading: 'Questa pagina non è ancora stata costruita.',
		error_403_heading: 'Non hai accesso a questa risorsa.',
		error_500_heading: 'Qualcosa si è rotto. Controlla i log.',
		error_back_home: 'Torna alla home',

		site_description: 'Stack full-stack typed: SvelteKit + Hono su Cloudflare Workers'
	}

	if (includeOtp) {
		base.otp_subject = 'Il tuo codice di verifica'
		base.otp_preview = 'Usa questo codice per accedere'
		base.otp_title = "Conferma l'accesso"
		base.otp_intro = "Inserisci questo codice per completare l'accesso:"
		base.otp_expiry = 'Il codice scade tra {expiryMinutes} minuti.'
	}

	if (includeAuth) {
		base.auth_signin = 'Accedi'
		base.auth_enter_code = 'Inserisci il codice'
		base.auth_otp_lede = 'Senza password. Ti invieremo un codice di 6 cifre via email.'
		base.auth_otp_sent_to_prefix = 'Inviato a'
		base.auth_email_label = 'Email'
		base.auth_send_code = 'Invia codice'
		base.auth_continue_google = 'Continua con Google'
		base.auth_or = 'oppure'
		base.auth_otp_code_label = 'Codice di 6 cifre'
		base.auth_verify_signin = 'Verifica e accedi'
		base.auth_use_different_email = 'Usa un altro indirizzo email'
		base.auth_turnstile_missing =
			'Chiave di verifica non configurata. Imposta PUBLIC_TURNSTILE_SITE_KEY prima del deploy.'

		base.auth_validation_email_invalid = 'Inserisci una email valida'
		base.auth_validation_otp_invalid = 'Il codice deve essere di 6 cifre'
		base.auth_validation_turnstile_required = 'Completa la verifica'
		base.auth_validation_name_required = 'Il nome è obbligatorio'
		base.auth_validation_name_too_long = 'Il nome è troppo lungo'

		base.auth_otp_send_failed = 'Impossibile inviare il codice. Riprova.'
		base.auth_otp_send_success = 'Codice inviato. Controlla la tua casella.'
		base.auth_otp_too_many_requests = 'Troppe richieste. Riprova fra un minuto.'
		base.auth_otp_invalid_code = 'Codice non valido o scaduto'
		base.auth_verification_failed = 'Verifica fallita — riprova'

		base.account_update_failed = 'Impossibile aggiornare il profilo.'
		base.account_update_success = 'Profilo aggiornato.'

		base.me_title = 'Connesso'
		base.me_email_label = 'Email'
		base.me_name_label = 'Nome'
		base.me_manage_account = 'Gestisci account'

		base.account_title = 'Account'
		base.account_lede = 'Gestisci il tuo profilo e la sessione.'
		base.account_profile_title = 'Profilo'
		base.account_profile_desc =
			"Il tuo nome visualizzato. L'email è impostata al momento dell'accesso."
		base.account_name_label = 'Nome'
		base.account_email_label = 'Email'
		base.account_save = 'Salva modifiche'
		base.account_session_title = 'Sessione'
		base.account_session_desc = 'Esci da questo browser.'
		base.account_signout = 'Esci'
		base.account_delete_title = 'Elimina account'
		base.account_delete_desc =
			"Rimuovi definitivamente il tuo account e tutti i dati associati. L'azione non può essere annullata."
		base.account_delete_button = 'Elimina account'
		base.account_delete_confirm_title = "Eliminare l'account?"
		base.account_delete_confirm_desc =
			'Questo eliminerà definitivamente il tuo account e tutti i dati associati. Non potrai recuperarlo.'
		base.account_cancel = 'Annulla'
		base.account_delete_yes = 'Sì, elimina'
		base.account_delete_failed = "Impossibile eliminare l'account."
		base.account_delete_success = 'Account eliminato.'
	}

	if (includeApiClient) {
		base.users_title = 'Utente corrente'
		base.users_lede =
			'Recuperato lato client tramite il client generato, in cache con TanStack Query.'
		base.users_loading = 'Caricamento…'
		base.users_name_label = 'Nome'
		base.users_email_label = 'Email'
	}

	if (includeMarketing) {
		base.marketing_title = 'Costruisci il prodotto, non la configurazione.'
		base.marketing_lede = "Un punto di partenza essenziale per il sito pubblico e l'applicazione."
		base.marketing_cta = "Apri l'applicazione"
		base.app_home_title = 'Applicazione'
		base.app_home_lede = "L'applicazione è pronta per la sua prima funzionalità."
	}

	return JSON.stringify(base, null, 2) + '\n'
}

const PACKAGE_JSON =
	JSON.stringify(
		{
			name: '@repo/i18n',
			version: '0.0.0',
			private: true,
			type: 'module',
			exports: {
				'./messages': './src/paraglide/messages.js',
				'./runtime': './src/paraglide/runtime.js',
				'./server': './src/paraglide/server.js'
			},
			scripts: {
				build:
					'paraglide-js compile --project ./project.inlang --outdir ./src/paraglide --emit-ts-declarations',
				dev: 'paraglide-js compile --project ./project.inlang --outdir ./src/paraglide --emit-ts-declarations --watch'
			},
			dependencies: {
				'@inlang/paraglide-js': '^2.0.0'
			},
			devDependencies: {
				'@repo/tooling-typescript': 'workspace:*'
			}
		},
		null,
		2
	) + '\n'

const TSCONFIG = `{
	"extends": "@repo/tooling-typescript/library.json",
	"include": ["src/**/*"],
	"exclude": ["node_modules"]
}
`

const GITIGNORE = `src/paraglide/
node_modules/
`

// Paraglide v2 uses `baseLocale` + `locales` (not v1's `sourceLanguageTag` + `languageTags`).
const INLANG_SETTINGS =
	JSON.stringify(
		{
			$schema: 'https://inlang.com/schema/project-settings',
			baseLocale: 'en',
			locales: ['en', 'it'],
			modules: ['https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js'],
			'plugin.inlang.messageFormat': {
				pathPattern: './messages/{locale}.json'
			}
		},
		null,
		2
	) + '\n'

const README = `# @repo/i18n

Paraglide v2 messages compiled into \`src/paraglide/\` and consumed by every package.

## Compile

\`\`\`
pnpm build       # one-shot
pnpm dev         # watch mode
\`\`\`

## Use

From any package or app:

\`\`\`ts
import * as m from '@repo/i18n/messages'
import { setLocale, getLocale } from '@repo/i18n/runtime'

m.greeting({ name: 'Ada' })                      // uses current locale
m.greeting({ name: 'Ada' }, { locale: 'it' })    // explicit locale
\`\`\`

## Concurrency on Workers

Paraglide's runtime locale is module-scoped. On Cloudflare Workers (or any
server with concurrent requests) wrap each request with the middleware so
locale is isolated per request:

\`\`\`ts
import { paraglideMiddleware } from '@repo/i18n/server'

export default {
	async fetch(req: Request) {
		return paraglideMiddleware(req, async ({ request, locale }) => {
			// handler runs with isolated locale
		})
	}
}
\`\`\`

For email rendering or other contexts where locale comes from data
(recipient preference) instead of the request, pass it explicitly per call:
\`m.greeting(props, { locale: recipient.locale })\`.

## Adding messages

1. Edit \`messages/<locale>.json\`.
2. Re-run \`pnpm build\` (or keep \`pnpm dev\` running).
3. Compiled output in \`src/paraglide/messages.js\` updates with new keys;
   TypeScript catches mismatches in consumers.

## Adding a locale

1. Add the tag to \`project.inlang/settings.json\` → \`locales\`.
2. Create \`messages/<tag>.json\` with the same keys as \`en.json\`.
3. Recompile.

## Notes

- Paraglide v2 uses \`baseLocale\` + \`locales\` (the v1 names
  \`sourceLanguageTag\` / \`languageTags\` are no longer accepted).
- \`src/paraglide/\` is generated and gitignored — do not edit by hand.
`
