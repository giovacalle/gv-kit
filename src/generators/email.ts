import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import { AUTH_SERVICE } from './hono-topology.js'

export function generateEmail(cfg: GvKitConfig): FileEntry[] {
	const choice = cfg.choices.email
	if (choice === 'skip') return []
	if (choice === 'notifuse') return notifuseFiles()

	const usesParaglide = cfg.choices.i18n === 'paraglide'
	const usesOtp = cfg.choices.auth.includes('emailOTP')
	return resendFiles({ usesParaglide, usesOtp })
}

function notifuseFiles(): FileEntry[] {
	return [
		{ path: 'packages/mailer/package.json', content: NOTIFUSE_PKG_JSON },
		{ path: 'packages/mailer/tsconfig.json', content: NOTIFUSE_TSCONFIG },
		{ path: 'packages/mailer/tsup.config.ts', content: NOTIFUSE_TSUP },
		{ path: 'packages/mailer/src/index.ts', content: NOTIFUSE_INDEX_TS },
		{ path: 'packages/mailer/src/types.ts', content: NOTIFUSE_TYPES_TS },
		{ path: 'packages/mailer/src/client.ts', content: NOTIFUSE_CLIENT_TS },
		{ path: 'packages/mailer/README.md', content: NOTIFUSE_README }
	]
}

function resendFiles({
	usesParaglide,
	usesOtp
}: {
	usesParaglide: boolean
	usesOtp: boolean
}): FileEntry[] {
	const entries: FileEntry[] = [
		{ path: 'packages/mailer/package.json', content: resendPkgJson(usesParaglide) },
		{ path: 'packages/mailer/tsconfig.json', content: RESEND_TSCONFIG },
		{ path: 'packages/mailer/tsup.config.ts', content: resendTsupConfig(usesParaglide) },
		{ path: 'packages/mailer/src/index.ts', content: RESEND_INDEX_TS },
		{ path: 'packages/mailer/src/types.ts', content: RESEND_TYPES_TS },
		{ path: 'packages/mailer/src/render.ts', content: RESEND_RENDER_TS },
		{ path: 'packages/mailer/src/client.ts', content: RESEND_CLIENT_TS },
		{
			path: 'packages/mailer/src/templates/index.ts',
			content: resendTemplatesIndexTs(usesOtp)
		},
		{
			path: 'packages/mailer/src/templates/_shared/types.ts',
			content: resendSharedTypesTs(usesParaglide)
		},
		{
			path: 'packages/mailer/src/templates/_shared/Layout.tsx',
			content: RESEND_LAYOUT_TSX
		},
		{
			path: 'packages/mailer/src/templates/welcome.tsx',
			content: resendWelcomeTsx(usesParaglide)
		},
		{ path: 'packages/mailer/README.md', content: resendReadme(usesParaglide, usesOtp) }
	]

	if (usesOtp) {
		entries.push({
			path: 'packages/mailer/src/templates/otp-login.tsx',
			content: resendOtpLoginTsx(usesParaglide)
		})
	}

	return entries
}

// -----------------------------------------------------------------------------
// Notifuse OSS (self-hosted) — thin RPC client over POST /api/transactional.send
// Templates live in the Notifuse console (MJML + Liquid). No local rendering.
// -----------------------------------------------------------------------------

const NOTIFUSE_PKG_JSON =
	JSON.stringify(
		{
			name: '@repo/mailer',
			version: '0.0.0',
			private: true,
			type: 'module',
			main: './dist/index.js',
			types: './dist/index.d.ts',
			exports: {
				'.': {
					types: './dist/index.d.ts',
					default: './dist/index.js'
				}
			},
			files: ['dist'],
			scripts: {
				build: 'tsup',
				dev: 'tsup --watch',
				typecheck: 'tsc --noEmit',
				lint: 'eslint .'
			},
			devDependencies: {
				'@repo/tooling-typescript': 'workspace:*',
				tsup: '^8.5.0'
			}
		},
		null,
		2
	) + '\n'

const NOTIFUSE_TSCONFIG = `{
	"extends": "@repo/tooling-typescript/library.json",
	"compilerOptions": {
		"lib": ["ES2022", "DOM"],
		"outDir": "dist"
	},
	"include": ["src/**/*"],
	"exclude": ["node_modules", "dist"]
}
`

const NOTIFUSE_TSUP = `import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	sourcemap: true
})
`

const NOTIFUSE_INDEX_TS = `export { createMailer, type Mailer, type MailerConfig } from './client.js'
export {
	MailerError,
	type Contact,
	type EmailOptions,
	type SendInput,
	type SendResult
} from './types.js'
`

const NOTIFUSE_TYPES_TS = `export type Contact = {
	email: string
	external_id?: string
	language?: string
	first_name?: string
	last_name?: string
	full_name?: string
	timezone?: string
	phone?: string
}

export type EmailOptions = {
	from_name?: string
	subject?: string
	subject_preview?: string
	cc?: string[]
	bcc?: string[]
	reply_to?: string
}

export type SendInput = {
	to: Contact | string
	template: string
	data?: Record<string, unknown>
	external_id?: string
	metadata?: Record<string, unknown>
	email_options?: EmailOptions
}

export type SendResult = { message_id: string }

export class MailerError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause })
		this.name = 'MailerError'
	}
}
`

const NOTIFUSE_CLIENT_TS = `import { MailerError, type Contact, type SendInput, type SendResult } from './types.js'

export type MailerConfig = {
	apiKey: string
	workspaceId: string
	baseUrl: string
}

export function createMailer({ apiKey, workspaceId, baseUrl }: MailerConfig) {
	const root = baseUrl.replace(/\\/+$/, '')

	async function send(input: SendInput): Promise<SendResult> {
		const contact: Contact = typeof input.to === 'string' ? { email: input.to } : input.to

		const notification: Record<string, unknown> = {
			id: input.template,
			contact,
			channels: ['email']
		}
		if (input.external_id) notification.external_id = input.external_id
		if (input.data) notification.data = input.data
		if (input.metadata) notification.metadata = input.metadata
		if (input.email_options) notification.email_options = input.email_options

		const res = await fetch(\`\${root}/api/transactional.send\`, {
			method: 'POST',
			headers: {
				authorization: \`Bearer \${apiKey}\`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ workspace_id: workspaceId, notification })
		})

		if (!res.ok) {
			const detail = await res.text()
			throw new MailerError(\`notifuse: \${res.status} \${detail}\`)
		}

		const data = (await res.json()) as { message_id?: string }
		if (!data.message_id) throw new MailerError('notifuse: no message_id returned')
		return { message_id: data.message_id }
	}

	return { send }
}

export type Mailer = ReturnType<typeof createMailer>
`

const NOTIFUSE_README = `# @repo/mailer

Thin RPC client for a self-hosted [Notifuse](https://notifuse.com) instance.
Notifuse owns the templates (authored in its console with MJML + Liquid) and
all rendering happens server-side. This package only knows how to POST
\`/api/transactional.send\` against a workspace.

## Layout

- \`src/client.ts\` — \`createMailer({ apiKey, workspaceId, baseUrl })\` returns \`{ send }\`
- \`src/types.ts\` — \`Contact\`, \`EmailOptions\`, \`SendInput\`, \`SendResult\`, \`MailerError\`
- \`src/index.ts\` — public re-exports

## Usage

\`\`\`ts
import { createMailer } from '@repo/mailer'

const mailer = createMailer({
	apiKey: env.NOTIFUSE_API_KEY,
	workspaceId: env.NOTIFUSE_WORKSPACE_ID,
	baseUrl: env.NOTIFUSE_BASE_URL
})

await mailer.send({
	to: { email: 'ada@example.com', language: 'en' },
	template: 'welcome',
	data: { name: 'Ada' }
})
\`\`\`

\`to\` accepts either a \`Contact\` object or a bare email string (shorthand for
\`{ email }\`). \`template\` is the **Notifuse transactional notification ID** —
the template must already exist in the workspace; create it in the Notifuse
console with the channels and MJML/Liquid body you need.

OTP example:

\`\`\`ts
await mailer.send({
	to: 'ada@example.com',
	template: 'otp-login',
	data: { code: '123456', expiry_minutes: 10 }
})
\`\`\`

\`data\` is a free-form bag passed straight through as Liquid variables —
field names should match what the template references (\`{{ code }}\`,
\`{{ expiry_minutes }}\`, …).

\`external_id\` enables idempotent sends; identical IDs are de-duped by
Notifuse. \`email_options\` overrides per-send fields like \`subject\`,
\`from_name\`, \`cc\`, \`bcc\`, \`reply_to\`.

## Channels

The client always passes \`channels: ['email']\`. Notifuse supports more
channels (SMS, push, …) but this package is email-only; extend the client
at the call site if a notification needs to fan out.

## Build

\`\`\`bash
pnpm build       # one-shot — clean dist/ then emit ESM + .d.ts
pnpm dev         # tsup --watch
\`\`\`

\`turbo run build\` wires \`^build\` so consumers (e.g. \`${AUTH_SERVICE.workspacePath}\`) get
\`packages/mailer/dist/\` rebuilt on demand. Run \`pnpm build\` once after
\`git clone\` if you skip the turbo orchestrator.

## Configuration

| Env var | Required | Description |
|---|---|---|
| NOTIFUSE_API_KEY | yes | Workspace-scoped API key. Create it in the Notifuse console (\`Settings → API keys\`). The token is a JWT — pass it raw, the client wraps it in \`Authorization: Bearer …\` |
| NOTIFUSE_WORKSPACE_ID | yes | Workspace ID the API key belongs to |
| NOTIFUSE_BASE_URL | yes | Root URL of your Notifuse instance, e.g. \`https://notifuse.example.com\` (no trailing slash needed) |

Sender address and channel routing are configured **inside Notifuse**, not
here — pick the email integration + sender at the workspace level.

## Authoring templates

Templates live in Notifuse, not in this repo. To add a new transactional
email:

1. In the Notifuse console open \`Transactional notifications\` and create a
   new one. The \`ID\` you pick is what you'll pass as \`template\` from this
   client (e.g. \`welcome\`, \`password-reset\`, \`otp-login\`).
2. Add an \`email\` channel template. The body is MJML with Liquid; reference
   the variables you'll send in \`data\` as \`{{ var_name }}\`.
3. Test from the console with \`Send test\` before wiring it into code.

The \`data\` object passed to \`mailer.send\` is exactly the set of variables
your Liquid template can reference. Keep names snake_case to match
Notifuse's overall API style.
`

// -----------------------------------------------------------------------------
// Resend — react-email templates rendered locally to HTML + plain text
// -----------------------------------------------------------------------------

function resendPkgJson(usesParaglide: boolean): string {
	const dependencies: Record<string, string> = {
		react: '^19.0.0',
		'react-email': '^6.0.0',
		resend: '^4.0.0'
	}
	if (usesParaglide) dependencies['@repo/i18n'] = 'workspace:*'

	return (
		JSON.stringify(
			{
				name: '@repo/mailer',
				version: '0.0.0',
				private: true,
				type: 'module',
				main: './dist/index.js',
				types: './dist/index.d.ts',
				exports: {
					'.': {
						types: './dist/index.d.ts',
						default: './dist/index.js'
					}
				},
				files: ['dist'],
				scripts: {
					build: 'tsup',
					dev: 'tsup --watch',
					preview: 'email dev --dir src/templates --port 3001',
					typecheck: 'tsc --noEmit',
					lint: 'eslint .'
				},
				dependencies,
				devDependencies: {
					'@repo/tooling-typescript': 'workspace:*',
					'@types/react': '^19.0.0',
					tsup: '^8.5.0'
				}
			},
			null,
			2
		) + '\n'
	)
}

function resendTsupConfig(usesParaglide: boolean): string {
	const externals = ['react', 'react-email', 'resend']
	if (usesParaglide) externals.push('@repo/i18n')

	return `import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	sourcemap: true,
	external: ${JSON.stringify(externals)}
})
`
}

const RESEND_TSCONFIG = `{
	"extends": "@repo/tooling-typescript/library.json",
	"compilerOptions": {
		"allowJs": true,
		"jsx": "react-jsx",
		"lib": ["ES2022", "DOM"],
		"outDir": "dist"
	},
	"include": ["src/**/*"],
	"exclude": ["node_modules", "dist"]
}
`

const RESEND_TYPES_TS = `export type SendInput = {
	to: string | string[]
	from: string
	subject: string
	html: string
	text: string
}

export type SendResult = { id: string }

export class MailerError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause })
		this.name = 'MailerError'
	}
}
`

const RESEND_RENDER_TS = `import { render } from 'react-email'
import type { ReactElement } from 'react'

import { templates, type TemplateName, type TemplateProps } from './templates/index.js'

export async function renderTemplate<N extends TemplateName>(
	name: N,
	props: TemplateProps<N>
): Promise<{ html: string; text: string; subject: string }> {
	const t = templates[name]
	const element = (t.Body as (p: TemplateProps<N>) => ReactElement)(props)
	const [html, text] = await Promise.all([
		render(element),
		render(element, { plainText: true })
	])
	const rawSubject = t.subject as string | ((p: TemplateProps<N>) => string)
	const subject = typeof rawSubject === 'function' ? rawSubject(props) : rawSubject
	return { html, text, subject }
}
`

const RESEND_CLIENT_TS = `import { Resend } from 'resend'
import { renderTemplate } from './render.js'
import type { TemplateName, TemplateProps } from './templates/index.js'
import type { SendInput, SendResult } from './types.js'
import { MailerError } from './types.js'

export type SendTemplateInput<N extends TemplateName> = {
	from: string
	to: string | string[]
	template: N
	data: TemplateProps<N>
	subject?: string
}

export function createMailer(apiKey: string) {
	const resend = new Resend(apiKey)

	async function send(input: SendInput): Promise<SendResult> {
		const res = await resend.emails.send(input)
		if (res.error) throw new MailerError(res.error.message, res.error)
		if (!res.data?.id) throw new MailerError('resend: no message id returned')
		return { id: res.data.id }
	}

	async function sendTemplate<N extends TemplateName>(
		input: SendTemplateInput<N>
	): Promise<SendResult> {
		const { html, text, subject } = await renderTemplate(input.template, input.data)
		return send({
			from: input.from,
			to: input.to,
			subject: input.subject ?? subject,
			html,
			text
		})
	}

	return { send, sendTemplate }
}

export type Mailer = ReturnType<typeof createMailer>
`

function resendTemplatesIndexTs(usesOtp: boolean): string {
	const otpImport = usesOtp ? `import * as Otp from './otp-login.js'\n` : ''
	const otpEntry = usesOtp ? `,\n\totp: { Body: Otp.default, subject: Otp.subject }` : ''

	return `import type { ComponentProps } from 'react'

import * as Welcome from './welcome.js'
${otpImport}
export const templates = {
	welcome: { Body: Welcome.default, subject: Welcome.subject }${otpEntry}
} as const

export type TemplateName = keyof typeof templates
export type TemplateProps<N extends TemplateName> = ComponentProps<(typeof templates)[N]['Body']>
`
}

function resendSharedTypesTs(usesParaglide: boolean): string {
	if (usesParaglide) {
		return `import type { Locale } from '@repo/i18n/runtime'

export type { Locale }
export type BaseTemplateProps = { locale: Locale }
`
	}

	return `export type Locale = 'en'

export type BaseTemplateProps = { locale: Locale }
`
}

const RESEND_LAYOUT_TSX = `import { Body, Container, Head, Html, Preview, Tailwind } from 'react-email'
import type { ReactNode } from 'react'

export type LayoutProps = {
	preview: string
	children: ReactNode
}

const tailwindConfig = {
	theme: {
		extend: {
			// colors: { brand: '#007ee6' },
			// fontFamily: { sans: ['Inter', 'sans-serif'] }
		}
	}
}

export default function Layout({ preview, children }: LayoutProps) {
	return (
		<Html>
			<Head />
			<Preview>{preview}</Preview>
			<Tailwind config={tailwindConfig}>
				<Body className="bg-gray-50 font-sans py-8">
					<Container className="bg-white max-w-lg mx-auto p-8 rounded-lg shadow-sm">
						{/* Replace with your brand logo:
						    <Img src="https://example.com/logo.png" alt="Logo" width="40" height="40" /> */}
						<div className="text-3xl mb-4">📧</div>
						{children}
					</Container>
				</Body>
			</Tailwind>
		</Html>
	)
}
`

function resendWelcomeTsx(usesParaglide: boolean): string {
	if (usesParaglide) {
		return `import { Heading, Text } from 'react-email'
import * as m from '@repo/i18n/messages'

import Layout from './_shared/Layout.js'
import type { BaseTemplateProps } from './_shared/types.js'

export type WelcomeProps = BaseTemplateProps & { name: string }

export default function WelcomeEmail({ name, locale }: WelcomeProps) {
	return (
		<Layout preview={m.welcome_preview({ name }, { locale })}>
			<Heading className="text-2xl font-bold text-gray-900 mb-4">
				{m.welcome_title({ name }, { locale })}
			</Heading>
			<Text className="text-base text-gray-700 leading-relaxed">
				{m.welcome_body({}, { locale })}
			</Text>
		</Layout>
	)
}

export const subject = ({ name, locale }: WelcomeProps): string =>
	m.welcome_subject({ name }, { locale })
`
	}

	return `import { Heading, Text } from 'react-email'

import Layout from './_shared/Layout.js'
import type { BaseTemplateProps } from './_shared/types.js'

export type WelcomeProps = BaseTemplateProps & { name: string }

export default function WelcomeEmail({ name }: WelcomeProps) {
	return (
		<Layout preview={\`Welcome aboard, \${name}\`}>
			<Heading className="text-2xl font-bold text-gray-900 mb-4">
				Welcome, {name}
			</Heading>
			<Text className="text-base text-gray-700 leading-relaxed">
				Thanks for signing up — we're glad you're here.
			</Text>
		</Layout>
	)
}

export const subject = ({ name }: WelcomeProps): string => \`Welcome, \${name}\`
`
}

function resendOtpLoginTsx(usesParaglide: boolean): string {
	if (usesParaglide) {
		return `import { Heading, Text } from 'react-email'
import * as m from '@repo/i18n/messages'

import Layout from './_shared/Layout.js'
import type { BaseTemplateProps } from './_shared/types.js'

export type OtpLoginProps = BaseTemplateProps & {
	code: string
	expiryMinutes: number
}

export default function OtpLoginEmail({ code, expiryMinutes, locale }: OtpLoginProps) {
	return (
		<Layout preview={m.otp_preview({}, { locale })}>
			<Heading className="text-2xl font-bold text-gray-900 mb-4">
				{m.otp_title({}, { locale })}
			</Heading>
			<Text className="text-base text-gray-700 mb-4">
				{m.otp_intro({}, { locale })}
			</Text>
			<Text className="text-3xl font-mono font-bold tracking-widest text-center bg-gray-100 py-4 rounded">
				{code}
			</Text>
			<Text className="text-sm text-gray-500 mt-4">
				{m.otp_expiry({ expiryMinutes }, { locale })}
			</Text>
		</Layout>
	)
}

export const subject = ({ locale }: OtpLoginProps): string =>
	m.otp_subject({}, { locale })
`
	}

	return `import { Heading, Text } from 'react-email'

import Layout from './_shared/Layout.js'
import type { BaseTemplateProps } from './_shared/types.js'

export type OtpLoginProps = BaseTemplateProps & {
	code: string
	expiryMinutes: number
}

export default function OtpLoginEmail({ code, expiryMinutes }: OtpLoginProps) {
	return (
		<Layout preview="Your verification code">
			<Heading className="text-2xl font-bold text-gray-900 mb-4">
				Your verification code
			</Heading>
			<Text className="text-base text-gray-700 mb-4">
				Use the code below to sign in.
			</Text>
			<Text className="text-3xl font-mono font-bold tracking-widest text-center bg-gray-100 py-4 rounded">
				{code}
			</Text>
			<Text className="text-sm text-gray-500 mt-4">
				This code expires in {expiryMinutes} minutes.
			</Text>
		</Layout>
	)
}

export const subject = (_: OtpLoginProps): string => 'Your verification code'
`
}

const RESEND_INDEX_TS = `export { renderTemplate } from './render.js'
export { createMailer, type Mailer, type SendTemplateInput } from './client.js'
export { templates, type TemplateName, type TemplateProps } from './templates/index.js'
export { MailerError, type SendInput, type SendResult } from './types.js'
export type { BaseTemplateProps, Locale } from './templates/_shared/types.js'
`

function resendReadme(usesParaglide: boolean, usesOtp: boolean): string {
	const otpListItem = usesOtp
		? `
- \`src/templates/otp-login.tsx\` — OTP sign-in code`
		: ''

	const otpExample = usesOtp
		? `

Or send an OTP login email:

\`\`\`ts
await mailer.sendTemplate({
	from: 'noreply@example.com',
	to: 'ada@example.com',
	template: 'otp',
	data: { code: '123456', expiryMinutes: 10, locale: 'en' }
})
\`\`\``
		: ''

	const i18nSection = usesParaglide
		? `

## Localising emails

Templates pull strings from \`@repo/i18n/messages\` and take a \`locale\`
through props. Resolve the recipient's locale at the call site (e.g. from
the user record) and pass it as part of \`data\`:

\`\`\`ts
await mailer.sendTemplate({
	from: 'noreply@example.com',
	to: recipient.email,
	template: 'welcome',
	data: { name: recipient.name, locale: recipient.locale }
})
\`\`\`

When i18n is disabled the \`Locale\` type collapses to \`'en'\` so the surface
stays the same — you can wire it up later without rewriting call sites.`
		: ''

	return `# @repo/mailer

Mail-sending package backed by [Resend](https://resend.com). Email
templates are authored as React components via [react-email](https://react.email),
styled with Tailwind, and rendered to HTML + plain text on demand.

## Layout

- \`src/templates/\` — one \`.tsx\` per email; default-export the component, named-export \`subject\`
- \`src/templates/_shared/Layout.tsx\` — Tailwind wrapper used by every template
- \`src/templates/_shared/types.ts\` — \`Locale\` and \`BaseTemplateProps\`
- \`src/templates/welcome.tsx\` — onboarding welcome${otpListItem}
- \`src/templates/index.ts\` — registry mapping a name to \`{ Body, subject }\`
- \`src/render.ts\` — \`renderTemplate(name, props)\` returns \`{ html, text, subject }\`
- \`src/client.ts\` — \`createMailer(env)\` returns \`{ send, sendTemplate }\`
- \`src/types.ts\` — \`SendInput\`, \`SendResult\`, \`MailerError\`

## Usage

Bind the env once with \`createMailer\` and use \`sendTemplate\` for the
common case (render + send in one call). The template's \`subject\` is used
unless you pass an explicit override.

\`\`\`ts
import { createMailer } from '@repo/mailer'

const mailer = createMailer(process.env.RESEND_API_KEY!)

await mailer.sendTemplate({
	from: 'noreply@example.com',
	to: 'ada@example.com',
	template: 'welcome',
	data: { name: 'Ada', locale: 'en' }
})
\`\`\`${otpExample}

For finer control (caching the rendered HTML, queueing the send) compose
the primitives manually:

\`\`\`ts
import { createMailer, renderTemplate } from '@repo/mailer'

const mailer = createMailer(process.env.RESEND_API_KEY!)
const { html, text, subject } = await renderTemplate('welcome', { name: 'Ada', locale: 'en' })

await mailer.send({
	from: 'noreply@example.com',
	to: 'ada@example.com',
	subject,
	html,
	text
})
\`\`\`

## Adding a template

1. Create \`src/templates/<name>.tsx\` wrapping content in \`<Layout>\`. Default-export
   the component and named-export a \`subject\` (string or function of props).
2. Register it in \`src/templates/index.ts\`:

\`\`\`ts
import * as MyEmail from './my-email.js'

export const templates = {
	welcome: { Body: Welcome.default, subject: Welcome.subject },
	myEmail: { Body: MyEmail.default, subject: MyEmail.subject }
} as const
\`\`\`

\`renderTemplate('myEmail', props)\` is now type-checked against the component's props.

## Build

This package ships compiled artefacts under \`dist/\`. Consumers import the
built ESM + types — the source \`.tsx\` templates stay internal and never leak
into a sibling worker's typecheck.

\`\`\`bash
pnpm build       # one-shot — clean dist/ then emit ESM + .d.ts
pnpm dev         # tsup --watch — rebuild on change while you iterate
pnpm preview     # react-email preview UI at http://localhost:3001
\`\`\`

\`turbo run build\` already wires \`^build\` so consumers (e.g. \`${AUTH_SERVICE.workspacePath}\`)
get \`packages/mailer/dist/\` rebuilt on demand. Run \`pnpm build\` once after
\`git clone\` if you skip the turbo orchestrator.

## Configuration

| Env var | Required | Description |
|---|---|---|
| RESEND_API_KEY | yes | Resend API key |
${i18nSection}
`
}
