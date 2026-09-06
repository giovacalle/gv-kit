import { parseJsonc } from '../lib/jsonc.js'

type WranglerTypeConfig = {
	vars?: Record<string, unknown>
	secrets?: { required?: string[] }
	services?: Array<{ binding: string }>
	d1_databases?: Array<{ binding: string }>
	assets?: { binding?: string }
}

export const CLOUDFLARE_TYPES_BOOTSTRAP_FILE = 'worker-configuration.bootstrap.d.ts'
export const CLOUDFLARE_TYPEGEN_SCRIPT =
	`wrangler types --include-runtime=false && rm -f ${CLOUDFLARE_TYPES_BOOTSTRAP_FILE}`

// Keep the bootstrap off Wrangler's default path so cf-typegen can replace it.
export function renderCloudflareBootstrapTypes(wranglerJsonc: string): string {
	const config = parseJsonc<WranglerTypeConfig>(wranglerJsonc)
	const bindings = new Map<string, string>()

	for (const name of Object.keys(config.vars ?? {})) bindings.set(name, 'string')
	for (const name of config.secrets?.required ?? []) bindings.set(name, 'string')
	for (const service of config.services ?? []) bindings.set(service.binding, 'Fetcher')
	for (const database of config.d1_databases ?? []) bindings.set(database.binding, 'D1Database')
	if (config.assets?.binding) bindings.set(config.assets.binding, 'Fetcher')

	const declarations = [...bindings]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, type]) => `\t${name}: ${type}`)
		.join('\n')
	const stringBindings = [...bindings]
		.filter(([, type]) => type === 'string')
		.map(([name]) => `"${name}"`)
		.sort()
		.join(' | ')

	return `/* eslint-disable -- pnpm cf-typegen replaces these bootstrap declarations */
/// <reference types="@cloudflare/workers-types" />
interface __BaseEnv_Env {
${declarations}
}
declare namespace Cloudflare {
\tinterface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
${
	stringBindings
		? `type StringifyValues<EnvType extends Record<string, unknown>> = {
\t[Binding in keyof EnvType]: EnvType[Binding] extends string ? EnvType[Binding] : string
}
declare namespace NodeJS {
\tinterface ProcessEnv extends StringifyValues<Pick<Cloudflare.Env, ${stringBindings}>> {}
}
`
		: ''
}`
}
