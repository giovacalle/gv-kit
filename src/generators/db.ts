import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/** Generator for `packages/db/`. Driver follows a (db x deploy) matrix. */
export function generateDb(cfg: GvKitConfig): FileEntry[] {
	const isSqlite = cfg.choices.db === 'sqlite'
	const isCf = cfg.choices.deploy === 'cf-workers'
	const hasAuth = cfg.choices.auth.length > 0
	const project = cfg.choices.name

	const entries: FileEntry[] = [
		{ path: 'packages/db/package.json', content: renderPackageJson({ project, isSqlite, isCf }) },
		{ path: 'packages/db/tsconfig.json', content: renderTsconfig({ isCf, isSqlite }) },
		{ path: 'packages/db/drizzle.config.ts', content: renderDrizzleConfig({ isSqlite, isCf }) },
		{ path: 'packages/db/src/client.ts', content: renderClient({ isSqlite, isCf }) },
		{ path: 'packages/db/src/index.ts', content: renderIndex(hasAuth) },
		{ path: 'packages/db/src/schema/index.ts', content: renderSchemaIndex(hasAuth) },
		{ path: 'packages/db/src/schema/sample.ts', content: renderSampleSchema(isSqlite) },
		{ path: 'packages/db/migrations/.gitkeep', content: '' },
		{ path: 'packages/db/README.md', content: renderReadme({ isSqlite, isCf, hasAuth }) }
	]

	if (hasAuth)
		entries.push({ path: 'packages/db/src/schema/auth.ts', content: renderAuthSchema(isSqlite) })

	return entries
}

function renderPackageJson({
	project,
	isSqlite,
	isCf
}: {
	project: string
	isSqlite: boolean
	isCf: boolean
}): string {
	const dependencies: Record<string, string> = {
		'drizzle-orm': '^0.45.0',
		'drizzle-zod': '^0.8.3',
		zod: '^4.3.0'
	}

	if (!isSqlite) dependencies['postgres'] = '^3.4.0'
	if (isSqlite && !isCf) dependencies['@libsql/client'] = '^0.14.0'

	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		'@types/node': '^22.10.0',
		'drizzle-kit': '^0.31.0',
		typescript: '~5.9.0'
	}
	if (isCf) devDependencies['@cloudflare/workers-types'] = '^4.20251101.0'
	if (isCf && isSqlite) devDependencies.wrangler = '^4.85.0'

	const scripts: Record<string, string> = {
		'db:generate': 'drizzle-kit generate',
		'db:migrate': 'drizzle-kit migrate',
		'db:push': 'drizzle-kit push',
		'db:studio': 'drizzle-kit studio',
		typecheck: 'tsc --noEmit',
		lint: 'eslint .'
	}
	if (isCf) {
		scripts['db:migrate:production'] = isSqlite
			? `wrangler d1 migrations apply ${project}-db --remote`
			: 'drizzle-kit migrate'
	}
	if (isCf && isSqlite) {
		scripts['db:migrate:local'] = `wrangler d1 migrations apply ${project}-db --local`
	}

	const pkg = {
		name: '@repo/db',
		version: '0.0.0',
		private: true,
		type: 'module',
		exports: {
			'.': './src/index.ts',
			'./client': './src/client.ts',
			'./schema': './src/schema/index.ts'
		},
		scripts,
		dependencies,
		devDependencies
	}
	return JSON.stringify(pkg, null, 2) + '\n'
}

function renderTsconfig({
	isCf,
	isSqlite: _isSqlite
}: {
	isCf: boolean
	isSqlite: boolean
}): string {
	if (isCf) {
		return `{
	"extends": "@repo/tooling-typescript/library.json",
	"compilerOptions": {
		"types": ["node", "@cloudflare/workers-types"]
	},
	"include": ["src/**/*", "drizzle.config.ts"]
}
`
	}
	return `{
	"extends": "@repo/tooling-typescript/node.json",
	"compilerOptions": {
		"noEmit": true
	},
	"include": ["src/**/*", "drizzle.config.ts"]
}
`
}

function renderDrizzleConfig({ isSqlite, isCf }: { isSqlite: boolean; isCf: boolean }): string {
	if (isSqlite && isCf) {
		return `import { defineConfig } from 'drizzle-kit'

// drizzle-kit only generates SQL; \`wrangler d1 migrations apply\` runs it.
export default defineConfig({
	schema: './src/schema/index.ts',
	out: './migrations',
	dialect: 'sqlite',
	driver: 'd1-http',
	dbCredentials: {
		accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
		databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '',
		token: process.env.CLOUDFLARE_D1_TOKEN ?? ''
	},
	strict: true,
	verbose: true
})
`
	}
	if (isSqlite) {
		return `import { defineConfig } from 'drizzle-kit'

export default defineConfig({
	schema: './src/schema/index.ts',
	out: './migrations',
	dialect: 'sqlite',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? 'file:./local.db'
	},
	strict: true,
	verbose: true
})
`
	}
	return `import { defineConfig } from 'drizzle-kit'

export default defineConfig({
	schema: './src/schema/index.ts',
	out: './migrations',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? ''
	},
	strict: true,
	verbose: true
})
`
}

function renderClient({ isSqlite, isCf }: { isSqlite: boolean; isCf: boolean }): string {
	if (isSqlite && isCf) {
		return `import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from './schema/index.js'

export function createDb(env: { DB: D1Database }) {
	return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof createDb>
`
	}
	if (isSqlite) {
		return `import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './schema/index.js'

export function createDb(opts: { url: string }) {
	const client = createClient({ url: opts.url })
	return drizzle(client, { schema })
}

export type Db = ReturnType<typeof createDb>
`
	}
	if (!isSqlite && isCf) {
		return `import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema/index.js'

export function createDb(env: {
	HYPERDRIVE?: { connectionString: string } | undefined
	DATABASE_URL?: string | undefined
}) {
	const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL
	if (!url) throw new Error('No database connection: set HYPERDRIVE binding or DATABASE_URL')
	// max: 5 + prepare: false required for Hyperdrive on per-isolate runtime.
	const sql = postgres(url, { max: 5, prepare: false })
	return drizzle(sql, { schema })
}

export type Db = ReturnType<typeof createDb>
`
	}
	return `import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema/index.js'

export function createDb(env: { DATABASE_URL: string }) {
	const sql = postgres(env.DATABASE_URL)
	return drizzle(sql, { schema })
}

export type Db = ReturnType<typeof createDb>
`
}

function renderIndex(hasAuth: boolean): string {
	const lines = [
		`export { createDb } from './client.js'`,
		`export type { Db } from './client.js'`,
		`export * as schema from './schema/index.js'`
	]
	if (hasAuth) lines.push(`export * as authSchema from './schema/auth.js'`)
	return lines.join('\n') + '\n'
}

function renderSchemaIndex(hasAuth: boolean): string {
	const lines: string[] = []
	if (hasAuth) lines.push(`export * from './auth.js'`)
	lines.push(`export * from './sample.js'`)
	return lines.join('\n') + '\n'
}

function renderSampleSchema(isSqlite: boolean): string {
	if (isSqlite) {
		return `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const posts = sqliteTable('posts', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
})
`
	}
	return `import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})
`
}

function renderAuthSchema(isSqlite: boolean): string {
	if (isSqlite) {
		return `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Owned exclusively by the auth service. NO other service may query these tables.
export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})

export const session = sqliteTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	token: text('token').notNull().unique(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})

export const account = sqliteTable('account', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
	refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
	scope: text('scope'),
	password: text('password'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})

export const verification = sqliteTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})
`
	}
	return `import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Owned exclusively by the auth service. NO other service may query these tables.
export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').notNull().default(false),
	image: text('image'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const session = pgTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	token: text('token').notNull().unique(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const account = pgTable('account', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
	refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
	scope: text('scope'),
	password: text('password'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const verification = pgTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
`
}

function renderReadme({
	isSqlite,
	isCf,
	hasAuth
}: {
	isSqlite: boolean
	isCf: boolean
	hasAuth: boolean
}): string {
	const driverLabel =
		isSqlite && isCf
			? 'Cloudflare D1 (`drizzle-orm/d1`)'
			: isSqlite
				? 'libsql (`@libsql/client` + `drizzle-orm/libsql`)'
				: isCf
					? 'Neon Postgres (`postgres.js` + `drizzle-orm/postgres-js`)'
					: 'Postgres (`postgres.js`)'
	const cfPostgresDriver = isCf
		? 'Neon Postgres via `postgres.js`'
		: '`postgres.js` (connection from Hyperdrive binding)'
	const cfPostgresNotes =
		!isSqlite && isCf
			? `For Cloudflare Postgres, use Neon. Production uses \`DATABASE_URL\`;
PR previews can use Neon branches with their own temporary \`DATABASE_URL\`.

`
			: ''

	return `# @repo/db

Drizzle schema, migrations, and a deploy-aware client factory.

## Driver

This project uses **${driverLabel}**.

| Choice | Driver |
|--------|--------|
| sqlite + cf-workers | \`drizzle-orm/d1\` |
| sqlite + non-cf | \`@libsql/client\` (file: or libsql:// URLs) |
| postgres + cf-workers | ${cfPostgresDriver} |
| postgres + non-cf | \`postgres.js\` |

The active driver is selected at scaffold time. To switch, regenerate.

## Schemas

- \`src/schema/sample.ts\` — small \`posts\` table (replace once you add real tables)
${hasAuth ? '- `src/schema/auth.ts` — better-auth tables (`user`, `session`, `account`, `verification`)\n' : ''}

## Migration workflow

\`\`\`bash
# Generate SQL from the current schema
pnpm db:generate

# Apply (non-D1)
pnpm db:migrate
\`\`\`

${
	isSqlite && isCf
		? `For D1, drizzle-kit emits SQL into \`./migrations\` and \`wrangler d1 migrations apply\`
runs them against the database:

\`\`\`bash
wrangler d1 migrations apply <database-name> --local   # local
wrangler d1 migrations apply <database-name> --remote  # remote
\`\`\`
`
		: ''
}
	${cfPostgresNotes}${
		hasAuth
			? `
	## Schema regeneration (auth tables)

The auth tables follow better-auth's canonical schema. When you enable a
plugin that adds fields (e.g. organisations, two-factor), regenerate
\`src/schema/auth.ts\` instead of editing it by hand:

\`\`\`bash
npx @better-auth/cli@latest generate --adapter drizzle --output packages/db/src/schema/auth.ts
\`\`\`

Then run \`pnpm db:generate\` and review the diff.
`
			: ''
	}
## Boundary

\`@repo/db\` exports schema and a client factory. It does NOT contain auth
business logic — that lives in the auth service. Other services consume the
schema they own; the auth tables here are queried only by the auth service.
`
}
