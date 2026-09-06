import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import { generateAiTooling } from './ai-tooling.js'
import { generateApi } from './api.js'
import { generateBackend } from './backend.js'
import { generateDb } from './db.js'
import { generateDeploy } from './deploy.js'
import { generateEmail } from './email.js'
import { generateFrontendSveltekit } from './frontend-sveltekit.js'
import { generateHooks } from './hooks.js'
import { generateI18n } from './i18n.js'
import { generateMarketingAstro } from './marketing-astro.js'
import { generateMonitoring } from './monitoring.js'
import { generateOpenapiClient } from './openapi-client.js'
import { generateRoot } from './root.js'
import { generateTooling } from './tooling.js'
import { generateUi } from './ui.js'

export function runGenerators(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [
		...generateRoot(cfg),
		...generateTooling(cfg),
		...generateHooks(cfg),
		...generateBackend(cfg),
		...generateApi(cfg),
		...generateFrontendSveltekit(cfg),
		...generateMarketingAstro(cfg),
		...generateUi(cfg),
		...generateDb(cfg),
		...generateI18n(cfg),
		...generateOpenapiClient(cfg),
		...generateMonitoring(cfg),
		...generateEmail(cfg),
		...generateDeploy(cfg),
		...generateAiTooling(cfg),
		{
			path: 'project.config.jsonc',
			content: renderConfigJsonc(cfg)
		}
	]
	return entries
}

function renderConfigJsonc(cfg: GvKitConfig): string {
	const {
		name,
		frontend,
		marketing,
		backend,
		i18n,
		monitoring,
		db,
		apiClient,
		auth,
		email,
		aiTooling,
		deploy
	} = cfg.choices
	const arr = (xs: readonly string[]) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`
	return `{
\t"configVersion": ${cfg.configVersion},
\t"choices": {
\t\t"name": ${JSON.stringify(name)},
\t\t"frontend": ${JSON.stringify(frontend)},
\t\t"marketing": ${JSON.stringify(marketing)},
\t\t"backend": ${JSON.stringify(backend)},
\t\t"i18n": ${JSON.stringify(i18n)},
\t\t"monitoring": ${arr(monitoring)},
\t\t"db": ${JSON.stringify(db)},
\t\t"apiClient": ${JSON.stringify(apiClient)},
\t\t"auth": ${arr(auth)},
\t\t"email": ${JSON.stringify(email)},
\t\t"aiTooling": ${arr(aiTooling)},
\t\t"deploy": ${JSON.stringify(deploy)}
\t}
}
`
}
