import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/** Generator for `packages/openapi-client/`. Gated on `apiClient === 'hey-api'`. */
export function generateOpenapiClient(cfg: GvKitConfig): FileEntry[] {
	if (cfg.choices.apiClient !== 'hey-api') return []
	const effectMode = cfg.choices.backendRuntime === 'effect'

	return [
		{ path: 'packages/openapi-client/package.json', content: packageJson(effectMode) },
		{ path: 'packages/openapi-client/tsconfig.json', content: TSCONFIG },
		{ path: 'packages/openapi-client/openapi-ts.config.ts', content: OPENAPI_TS_CONFIG },
		{ path: 'packages/openapi-client/src/index.ts', content: SRC_INDEX },
		{ path: 'packages/openapi-client/src/users/index.ts', content: USERS_PLACEHOLDER },
		{ path: 'packages/openapi-client/README.md', content: README }
	]
}

function packageJson(effectMode: boolean): string {
	const dependencies: Record<string, string> = effectMode
		? {
				'@tanstack/svelte-query': '^6.1.33'
			}
		: {
				'@hey-api/client-fetch': '^0.13.1',
				'@tanstack/svelte-query': '^6.1.33'
			}

	return (
		JSON.stringify(
			{
				name: '@repo/openapi-client',
				version: '0.0.0',
				private: true,
				type: 'module',
				exports: {
					'.': './src/index.ts',
					'./users': './src/users/index.ts'
				},
				scripts: {
					codegen: 'openapi-ts',
					lint: 'eslint .'
				},
				dependencies,
				devDependencies: {
					'@hey-api/openapi-ts': effectMode ? '0.99.0' : '^0.97.3',
					'@repo/tooling-typescript': 'workspace:*',
					typescript: '~5.9.0'
				}
			},
			null,
			2
		) + '\n'
	)
}

const TSCONFIG = `{
	"extends": "@repo/tooling-typescript/library.json",
	"include": ["src/**/*", "openapi-ts.config.ts"],
	"exclude": ["node_modules", "dist"]
}
`

const OPENAPI_TS_CONFIG = `import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig([
	{
		input: '../../apps/api/users/openapi.json',
		// Pin tsConfigPath to this package — otherwise the generator walks up to the workspace-root tsconfig.
		output: { path: 'src/users', tsConfigPath: './tsconfig.json' },
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
	}
	// auth deliberately omitted — better-auth ships its own client.
])
`

const SRC_INDEX = `export * as users from './users/index.js'
`

// Overwritten by \`pnpm codegen\` (openapi-ts) once apps/api/users/openapi.json exists.
const USERS_PLACEHOLDER = `export {}
`

const README = `# @repo/openapi-client

Per-service TypeScript clients generated from each Hono service's OpenAPI spec
via [Hey API](https://heyapi.dev/). Each non-auth service also gets typed
[TanStack Query](https://tanstack.com/query) options for client-side data.

## How it works

\`apps/api/\` is a container of independently deployable Hono workers. Each
service dumps its own \`openapi.json\`; Hey API reads them and emits a
namespaced client into \`src/<service>/\`.

Consumers import per-namespace:

\`\`\`ts
import { getUsersMe, getUsersMeOptions } from '@repo/openapi-client/users'
\`\`\`

- \`getUsersMe(...)\` — plain typed SDK call. Use it server-side in
  \`+page.server.ts\` loads, passing the request \`fetch\`.
- \`getUsersMeOptions(...)\` — TanStack Query options. Pass to \`createQuery\` on
  client-side surfaces (live data, polling, infinite lists).

## Prerequisite: run codegen first

Generated files do not exist until you run codegen. Before the first
\`typecheck\`/\`dev\`, dump each spec and run:

\`\`\`bash
pnpm codegen
\`\`\`

\`src/<service>/index.ts\` ships as an empty placeholder and is overwritten by
codegen once \`apps/api/<service>/openapi.json\` exists. Treat this like
\`wrangler types\` — a generated artifact you refresh when the contract changes.

## Configuring the client (base URL + cookies)

The generated \`@hey-api/client-fetch\` instance is configured once in the web
app (base URL + \`credentials: 'include'\`). For server-side calls that must
forward the user's session cookie, pass the SvelteKit \`event.fetch\` per call:

\`\`\`ts
const { data } = await getUsersMe({ fetch })
\`\`\`

## Adding a new service

1. Dump \`apps/api/<svc>/openapi.json\`.
2. Add a job to \`openapi-ts.config.ts\` following the existing \`users\` entry
   (\`input\` + \`output: 'src/<svc>'\`).
3. Add a \`./<svc>\` subpath export in \`package.json\`.
4. Re-export it from \`src/index.ts\` as \`export * as <svc> from './<svc>/index.js'\`.
5. Run \`pnpm codegen\`.

## What is NOT here

- **auth** — \`better-auth\` ships its own typed client; consume it directly.
  The auth service's \`openapi.json\` only documents the internal
  \`/internal/session\` endpoint for service-to-service traffic, and is not fed
  to the generator.
`
