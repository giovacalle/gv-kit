import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/** Generator for shared tooling packages under `packages/tooling/*`. */
export function generateTooling(_cfg: GvKitConfig): FileEntry[] {
	return [
		{
			path: 'packages/tooling/typescript-config/package.json',
			content: TS_CONFIG_PACKAGE_JSON
		},
		{
			path: 'packages/tooling/typescript-config/base.json',
			content: TS_CONFIG_BASE
		},
		{
			path: 'packages/tooling/typescript-config/library.json',
			content: TS_CONFIG_LIBRARY
		},
		{
			path: 'packages/tooling/typescript-config/workers.json',
			content: TS_CONFIG_WORKERS
		},
		{
			path: 'packages/tooling/typescript-config/node.json',
			content: TS_CONFIG_NODE
		},
		{
			path: 'packages/tooling/typescript-config/sveltekit.json',
			content: TS_CONFIG_SVELTEKIT
		},
		{
			path: 'packages/tooling/eslint-config/package.json',
			content: ESLINT_PACKAGE_JSON
		},
		{
			path: 'packages/tooling/eslint-config/index.js',
			content: ESLINT_INDEX_JS
		},
		{
			path: 'packages/tooling/prettier-config/package.json',
			content: PRETTIER_PACKAGE_JSON
		},
		{
			path: 'packages/tooling/prettier-config/index.js',
			content: PRETTIER_INDEX_JS
		}
	]
}

const TS_CONFIG_PACKAGE_JSON =
	JSON.stringify(
		{
			name: '@repo/tooling-typescript',
			version: '0.0.0',
			private: true,
			exports: {
				'./base.json': './base.json',
				'./library.json': './library.json',
				'./workers.json': './workers.json',
				'./node.json': './node.json',
				'./sveltekit.json': './sveltekit.json'
			},
			dependencies: {
				'@cloudflare/workers-types': '^4.20240000.0',
				'@types/node': '^24.0.0'
			}
		},
		null,
		2
	) + '\n'

// exactOptionalPropertyTypes is intentionally omitted: bits-ui's optional prop
// types use `T | undefined` rather than `prop?: T`, which the strict variant
// rejects when forwarding `restProps` from primitive wrappers.
const TS_CONFIG_BASE = `{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"noImplicitOverride": true,
		"verbatimModuleSyntax": true,
		"isolatedModules": true,
		"esModuleInterop": true,
		"resolveJsonModule": true,
		"skipLibCheck": true,
		"allowSyntheticDefaultImports": true,
		"forceConsistentCasingInFileNames": true,
		"lib": ["ES2022"]
	},
	"exclude": ["node_modules", "dist", ".svelte-kit", ".wrangler", ".turbo"]
}
`

const TS_CONFIG_LIBRARY = `{
	"extends": "./base.json",
	"compilerOptions": {
		"noEmit": true
	}
}
`

const TS_CONFIG_WORKERS = `{
	"extends": "./base.json",
	"compilerOptions": {
		"types": ["@cloudflare/workers-types"]
	}
}
`

const TS_CONFIG_NODE = `{
	"extends": "./base.json",
	"compilerOptions": {
		"types": ["node"],
		"lib": ["ES2022", "DOM"]
	}
}
`

const TS_CONFIG_SVELTEKIT = `{
	"extends": "./base.json",
	"compilerOptions": {
		"types": ["svelte", "vite/client"]
	}
}
`

const ESLINT_PACKAGE_JSON =
	JSON.stringify(
		{
			name: '@repo/tooling-eslint',
			version: '0.0.0',
			private: true,
			type: 'module',
			main: './index.js',
			exports: {
				'.': './index.js'
			},
			dependencies: {
				'@eslint/js': '^9.0.0',
				'eslint-plugin-import': '^2.32.0',
				'eslint-plugin-svelte': '^3.0.0',
				globals: '^15.0.0',
				'typescript-eslint': '^8.0.0'
			}
		},
		null,
		2
	) + '\n'

const ESLINT_INDEX_JS = `import js from '@eslint/js'
import importPlugin from 'eslint-plugin-import'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	...svelte.configs['flat/recommended'],
	{
		plugins: { import: importPlugin },
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			'@typescript-eslint/no-explicit-any': 'warn',
			// guards against phantom deps that the hoisted linker would otherwise hide
			'import/no-extraneous-dependencies': 'warn',
			// internal links use plain hrefs throughout the scaffold; resolve() is optional
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		// Svelte rune class files end in .svelte.ts — make sure they use the TS parser
		files: ['**/*.svelte.ts'],
		languageOptions: {
			parser: tseslint.parser
		}
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser
			}
		}
	},
	{
		// SvelteKit's app.d.ts ships empty interfaces (App.Error, App.Locals, …) by design
		files: ['**/app.d.ts'],
		rules: {
			'@typescript-eslint/no-empty-object-type': 'off'
		}
	},
	{
		ignores: [
			'**/node_modules/**',
			'**/build/**',
			'**/dist/**',
			'**/.turbo/**',
			'**/.svelte-kit/**',
			'**/.wrangler/**',
			'**/worker-configuration.d.ts',
			'**/src/paraglide/**',
			'**/openapi-client/src/*/**',
			'**/*.gen.ts'
		]
	}
)
`

const PRETTIER_PACKAGE_JSON =
	JSON.stringify(
		{
			name: '@repo/tooling-prettier',
			version: '0.0.0',
			private: true,
			type: 'module',
			main: './index.js',
			exports: {
				'.': './index.js'
			},
			dependencies: {
				'@ianvs/prettier-plugin-sort-imports': '^4.4.0',
				'prettier-plugin-astro': '^0.14.1',
				'prettier-plugin-svelte': '^3.5.0',
				'prettier-plugin-tailwindcss': '^0.8.0'
			}
		},
		null,
		2
	) + '\n'

const PRETTIER_INDEX_JS = `import { createRequire } from 'node:module'

// Importing the plugin specifiers as strings would leave prettier to resolve them
// from the consumer's node_modules (which won't have them in a pnpm workspace).
// Resolving them via createRequire here pins resolution to THIS package, where
// the plugins are declared as dependencies — so any consumer that depends on
// @repo/tooling-prettier picks up the plugins transparently.
const require = createRequire(import.meta.url)

/** @type {import('prettier').Config} */
const config = {
	useTabs: true,
	tabWidth: 2,
	printWidth: 100,
	semi: false,
	singleQuote: true,
	trailingComma: 'none',
	arrowParens: 'always',
	bracketSpacing: true,
	bracketSameLine: true,
	endOfLine: 'lf',
	plugins: [
		require.resolve('@ianvs/prettier-plugin-sort-imports'),
		require.resolve('prettier-plugin-astro'),
		require.resolve('prettier-plugin-svelte'),
		require.resolve('prettier-plugin-tailwindcss')
	],
	overrides: [
		{ files: '*.astro', options: { parser: 'astro' } },
		{ files: '*.svelte', options: { parser: 'svelte' } }
	],
	importOrder: [
		'<BUILTIN_MODULES>',
		'',
		'^svelte(/|$)',
		'^@sveltejs',
		'',
		'<THIRD_PARTY_MODULES>',
		'',
		'^@repo/(.*)$',
		'',
		'^\\\\$lib/(.*)$',
		'^\\\\$app/(.*)$',
		'',
		'^[./]'
	]
}

export default config
`
