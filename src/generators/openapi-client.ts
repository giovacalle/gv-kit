import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/** Generator for `packages/openapi-client/`. Gated on `apiClient === 'hey-api'`. */
export function generateOpenapiClient(cfg: GvKitConfig): FileEntry[] {
	if (cfg.choices.apiClient !== 'hey-api') return []

	return [
		{ path: 'packages/openapi-client/package.json', content: PACKAGE_JSON },
		{ path: 'packages/openapi-client/tsconfig.json', content: TSCONFIG },
		{ path: 'packages/openapi-client/openapi-ts.config.ts', content: OPENAPI_TS_CONFIG },
		{ path: 'packages/openapi-client/src/index.ts', content: SRC_INDEX },
		{ path: 'packages/openapi-client/src/generated/index.ts', content: GENERATED_PLACEHOLDER },
		{ path: 'packages/openapi-client/README.md', content: README }
	]
}

const PACKAGE_JSON =
	JSON.stringify(
		{
			name: '@repo/openapi-client',
			version: '0.0.0',
			private: true,
			type: 'module',
			exports: { '.': './src/index.ts' },
			scripts: {
				codegen: 'openapi-ts',
				lint: 'eslint .'
			},
			dependencies: {
				'@hey-api/client-fetch': '^0.13.1',
				'@tanstack/svelte-query': '^6.1.33'
			},
			devDependencies: {
				'@hey-api/openapi-ts': '^0.97.3',
				'@repo/tooling-typescript': 'workspace:*',
				typescript: '~5.9.0'
			}
		},
		null,
		2
	) + '\n'

const TSCONFIG = `{
	"extends": "@repo/tooling-typescript/library.json",
	"include": ["src/**/*", "openapi-ts.config.ts"],
	"exclude": ["node_modules", "dist"]
}
`

const OPENAPI_TS_CONFIG = `import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
	input: '../../apps/api/openapi.json',
	// Pin tsConfigPath to this package so codegen never resolves the workspace-root config.
	output: { path: 'src/generated', tsConfigPath: './tsconfig.json' },
	plugins: [
		{ name: '@hey-api/client-fetch', exportFromIndex: true },
		'@hey-api/typescript',
		'@hey-api/sdk',
		{
			name: '@tanstack/svelte-query',
			exportFromIndex: true,
			queryOptions: true,
			infiniteQueryOptions: true,
			mutationOptions: true
		}
	]
})
`

const SRC_INDEX = `export * from './generated/index.js'
`

// Hey API replaces this ignored placeholder during the first workspace install.
const GENERATED_PLACEHOLDER = `export {}
`

const README = `# @repo/openapi-client

One flat TypeScript client generated from the composed gateway contract at
apps/api/openapi.json. Better Auth is excluded because it ships its own client.

Consumers import every domain-prefixed operation from the package root:

\`\`\`ts
import { usersGetMe, usersGetMeOptions } from '@repo/openapi-client'
\`\`\`

- usersGetMe is the plain typed SDK operation. Server loads pass url.origin and SvelteKit's request-scoped fetch.
- usersGetMeOptions provides TanStack Query options for browser reads.

Run pnpm codegen at the workspace root. The command first checks that the composed contract is
current, then asks Hey API to replace src/generated. Browser code configures the generated client
with an empty base URL for the same-origin /api alias. SSR passes url.origin plus event.fetch.
The request hook then uses the gateway binding or private gateway URL configured by the web runtime.

To add a domain service:

1. Add its deterministic public /api/v1 fragment to the gateway's explicit composition list.
2. Prefix every operationId with the domain name.
3. Run pnpm openapi:compose and pnpm codegen.

Do not add service package subpaths or feed Better Auth contracts to Hey API.
`
