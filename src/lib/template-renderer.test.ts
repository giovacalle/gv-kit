import { describe, expect, test } from 'bun:test'
import { renderFromRecord } from './template-renderer.js'

describe('renderFromRecord — file-tree walking', () => {
	test('emits all files under base/ with the path prefix', () => {
		const record = {
			'base/src/app.html': '<html></html>',
			'base/src/lib/utils.ts': 'export const x = 1\n',
			'base/static/favicon.svg': '<svg/>'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {}
		})
		const paths = entries.map((e) => e.path).sort()
		expect(paths).toEqual([
			'apps/web/src/app.html',
			'apps/web/src/lib/utils.ts',
			'apps/web/static/favicon.svg'
		])
	})

	test('keys outside base/, overlays/, and package.json.fragments/ are ignored', () => {
		const record = {
			'base/keep.txt': 'kept',
			'README.md': 'noise',
			'docs/internal.md': 'noise'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {}
		})
		expect(entries.map((e) => e.path)).toEqual(['apps/web/keep.txt'])
	})

	test('overlay files are emitted iff the overlay flag is true', () => {
		const record = {
			'base/keep.txt': 'always',
			'overlays/auth/src/auth.ts': 'auth-only',
			'overlays/i18n-paraglide/src/i18n.ts': 'i18n-only'
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false, i18nParaglide: false },
			vars: {}
		})
		expect(off.map((e) => e.path)).toEqual(['apps/web/keep.txt'])

		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true, i18nParaglide: true },
			vars: {}
		})
		expect(on.map((e) => e.path).sort()).toEqual([
			'apps/web/keep.txt',
			'apps/web/src/auth.ts',
			'apps/web/src/i18n.ts'
		])
	})

	test('overlay file overrides base file at the same path', () => {
		const record = {
			'base/src/foo.ts': 'base-version',
			'overlays/auth/src/foo.ts': 'auth-version'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true },
			vars: {}
		})
		expect(entries).toHaveLength(1)
		expect(entries[0]!.content).toBe('auth-version')
	})

	test('output entries are sorted by path', () => {
		const record = {
			'base/z.txt': 'z',
			'base/a.txt': 'a',
			'base/m.txt': 'm'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {}
		})
		expect(entries.map((e) => e.path)).toEqual([
			'apps/web/a.txt',
			'apps/web/m.txt',
			'apps/web/z.txt'
		])
	})
})

describe('renderFromRecord — output path prefixing', () => {
	test('web tree prefix is apps/web/', () => {
		const entries = renderFromRecord({
			record: { 'base/foo.ts': 'x' },
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {}
		})
		expect(entries[0]!.path).toBe('apps/web/foo.ts')
	})

	test('ui tree prefix is packages/ui/', () => {
		const entries = renderFromRecord({
			record: { 'base/index.ts': 'x' },
			pathPrefix: 'packages/ui/',
			flags: {},
			vars: {}
		})
		expect(entries[0]!.path).toBe('packages/ui/index.ts')
	})
})

describe('renderFromRecord — fence stripping', () => {
	test('HTML/Svelte fence kept when flag is true', () => {
		const record = {
			'base/x.svelte': 'before<!--@gvkit:if auth-->AUTH-BLOCK<!--@gvkit:endif-->after'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true },
			vars: {}
		})
		expect(entries[0]!.content).toBe('beforeAUTH-BLOCKafter')
		expect(entries[0]!.content).not.toContain('@gvkit:if')
		expect(entries[0]!.content).not.toContain('@gvkit:endif')
	})

	test('HTML/Svelte fence stripped when flag is false', () => {
		const record = {
			'base/x.svelte': 'before<!--@gvkit:if auth-->AUTH-BLOCK<!--@gvkit:endif-->after'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false },
			vars: {}
		})
		expect(entries[0]!.content).toBe('beforeafter')
	})

	test('TS/JS/CSS/JSONC fence kept when flag is true', () => {
		const record = {
			'base/x.ts': 'a/*@gvkit:if auth*/AUTH/*@gvkit:endif*/b'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true },
			vars: {}
		})
		expect(entries[0]!.content).toBe('aAUTHb')
	})

	test('TS/JS/CSS/JSONC fence stripped when flag is false', () => {
		const record = {
			'base/x.ts': 'a/*@gvkit:if auth*/AUTH/*@gvkit:endif*/b'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false },
			vars: {}
		})
		expect(entries[0]!.content).toBe('ab')
	})

	test('strip-without line directive removes the line when flag is false', () => {
		const record = {
			'base/x.ts': "import auth from 'better-auth' // @gvkit:strip-without auth\nconst always = 1\n"
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('const always = 1\n')

		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true },
			vars: {}
		})
		expect(on[0]!.content).toContain("import auth from 'better-auth'")
		expect(on[0]!.content).not.toContain('@gvkit:strip-without')
	})

	test('multi-line fence block is handled (no blank-line residue)', () => {
		const record = {
			'base/x.svelte': 'before\n<!--@gvkit:if auth-->\n  line1\n  line2\n<!--@gvkit:endif-->\nafter'
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('before\nafter')

		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true },
			vars: {}
		})
		expect(on[0]!.content).toBe('before\n  line1\n  line2\nafter')
	})

	test('HTML fence else branch is used when flag is false', () => {
		const record = {
			'base/x.svelte':
				'before<!--@gvkit:if i18nParaglide-->{m.title()}<!--@gvkit:else-->Title<!--@gvkit:endif-->after'
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { i18nParaglide: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('beforeTitleafter')

		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { i18nParaglide: true },
			vars: {}
		})
		expect(on[0]!.content).toBe('before{m.title()}after')
	})

	test('TS fence else branch is used when flag is false', () => {
		const record = {
			'base/x.ts':
				"const t = /*@gvkit:if i18nParaglide*/m.title()/*@gvkit:else*/'Title'/*@gvkit:endif*/\n"
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { i18nParaglide: false },
			vars: {}
		})
		expect(off[0]!.content).toBe("const t = 'Title'\n")

		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { i18nParaglide: true },
			vars: {}
		})
		expect(on[0]!.content).toBe('const t = m.title()\n')
	})

	test('block-level HTML fences consume their own lines (no blank-line residue)', () => {
		const record = {
			'base/x.svelte': 'line A\n<!--@gvkit:if X-->\ninner\n<!--@gvkit:endif-->\nline C\n'
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('line A\nline C\n')

		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: true },
			vars: {}
		})
		expect(on[0]!.content).toBe('line A\ninner\nline C\n')
	})

	test('block-level TS fences consume their own lines (no blank-line residue)', () => {
		const record = {
			'base/x.ts': 'a\n/*@gvkit:if X*/\nb\n/*@gvkit:endif*/\nc\n'
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('a\nc\n')

		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: true },
			vars: {}
		})
		expect(on[0]!.content).toBe('a\nb\nc\n')
	})

	test('indented block-level fences preserve content indentation', () => {
		const record = {
			'base/x.ts': 'function f() {\n\t/*@gvkit:if X*/\n\treturn 1\n\t/*@gvkit:endif*/\n}\n'
		}
		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: true },
			vars: {}
		})
		expect(on[0]!.content).toBe('function f() {\n\treturn 1\n}\n')

		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('function f() {\n}\n')
	})

	test('mid-line HTML fences keep surrounding content intact', () => {
		const record = {
			'base/x.svelte': '<a><!--@gvkit:if X-->A<!--@gvkit:else-->B<!--@gvkit:endif--></a>'
		}
		const on = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: true },
			vars: {}
		})
		expect(on[0]!.content).toBe('<a>A</a>')

		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { X: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('<a>B</a>')
	})

	test('nested HTML fences resolve innermost-first', () => {
		const record = {
			'base/x.svelte':
				'<!--@gvkit:if auth-->outer-<!--@gvkit:if i18nParaglide-->{m.x()}<!--@gvkit:else-->Sign in<!--@gvkit:endif-->-outer<!--@gvkit:endif-->'
		}
		const both = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true, i18nParaglide: true },
			vars: {}
		})
		expect(both[0]!.content).toBe('outer-{m.x()}-outer')

		const authOnly = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true, i18nParaglide: false },
			vars: {}
		})
		expect(authOnly[0]!.content).toBe('outer-Sign in-outer')

		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false, i18nParaglide: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('')
	})

	test('fence without else still works (backwards compatible)', () => {
		const record = {
			'base/x.svelte': 'before<!--@gvkit:if auth-->AUTH<!--@gvkit:endif-->after'
		}
		const off = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false },
			vars: {}
		})
		expect(off[0]!.content).toBe('beforeafter')
	})

	test('no fence directives leak into rendered output regardless of flag', () => {
		const record = {
			'base/a.ts': '/*@gvkit:if auth*/x/*@gvkit:endif*/',
			'base/b.svelte': '<!--@gvkit:if auth-->y<!--@gvkit:endif-->',
			'base/c.ts': 'z // @gvkit:strip-without auth\n'
		}
		for (const flag of [true, false]) {
			const entries = renderFromRecord({
				record,
				pathPrefix: 'apps/web/',
				flags: { auth: flag },
				vars: {}
			})
			for (const e of entries) {
				expect(e.content).not.toContain('@gvkit:if')
				expect(e.content).not.toContain('@gvkit:endif')
				expect(e.content).not.toContain('@gvkit:strip-without')
			}
		}
	})
})

describe('renderFromRecord — package.json deep-merge', () => {
	test('merges fragments and prefers later overlay values', () => {
		const record = {
			'package.json.fragments/base.json': JSON.stringify({
				name: '@__PROJECT__/web',
				dependencies: { svelte: '^5.0.0' }
			}),
			'package.json.fragments/auth.json': JSON.stringify({
				dependencies: { 'better-auth': '^1.6.0', zod: '^4.3.0' }
			})
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: true },
			vars: { __PROJECT__: 'demo' }
		})
		const pkg = entries.find((e) => e.path === 'apps/web/package.json')
		expect(pkg).toBeDefined()
		const parsed = JSON.parse(pkg!.content) as Record<string, unknown>
		expect(parsed.name).toBe('@demo/web')
		expect(parsed.dependencies).toEqual({
			'better-auth': '^1.6.0',
			svelte: '^5.0.0',
			zod: '^4.3.0'
		})
	})

	test('overlay fragment is excluded when its overlay flag is false', () => {
		const record = {
			'package.json.fragments/base.json': JSON.stringify({
				name: 'web',
				dependencies: { svelte: '^5.0.0' }
			}),
			'package.json.fragments/auth.json': JSON.stringify({
				dependencies: { 'better-auth': '^1.6.0' }
			})
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { auth: false },
			vars: {}
		})
		const pkg = entries.find((e) => e.path === 'apps/web/package.json')!
		const parsed = JSON.parse(pkg.content) as { dependencies: Record<string, string> }
		expect(parsed.dependencies).toEqual({ svelte: '^5.0.0' })
		expect(parsed.dependencies['better-auth']).toBeUndefined()
	})

	test('output uses 2-space indent and trailing newline', () => {
		const record = {
			'package.json.fragments/base.json': JSON.stringify({
				name: 'x',
				version: '0.0.0'
			})
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {}
		})
		const pkg = entries.find((e) => e.path === 'apps/web/package.json')!
		expect(pkg.content.endsWith('\n')).toBe(true)
		expect(pkg.content).toContain('  "name"')
	})

	test('keys are deterministically ordered (name first, dependencies before devDependencies)', () => {
		const record = {
			'package.json.fragments/base.json': JSON.stringify({
				devDependencies: { typescript: '^5.0.0' },
				dependencies: { svelte: '^5.0.0' },
				name: 'x',
				version: '0.0.0'
			})
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {}
		})
		const pkg = entries.find((e) => e.path === 'apps/web/package.json')!
		const idx = (key: string) => pkg.content.indexOf(`"${key}"`)
		expect(idx('name')).toBeLessThan(idx('version'))
		expect(idx('version')).toBeLessThan(idx('dependencies'))
		expect(idx('dependencies')).toBeLessThan(idx('devDependencies'))
	})

	test('package.json files inside base/ are NOT emitted directly — only fragments produce package.json', () => {
		const record = {
			'base/package.json': '{ "name": "should-be-ignored" }',
			'package.json.fragments/base.json': JSON.stringify({ name: 'real' })
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {}
		})
		const pkg = entries.find((e) => e.path === 'apps/web/package.json')!
		const parsed = JSON.parse(pkg.content) as { name: string }
		expect(parsed.name).toBe('real')
	})

	test('throws a clear error if a fragment is invalid JSON', () => {
		const record = {
			'package.json.fragments/base.json': '{ not: valid'
		}
		expect(() =>
			renderFromRecord({
				record,
				pathPrefix: 'apps/web/',
				flags: {},
				vars: {}
			})
		).toThrow(/not valid JSON/)
	})
})

describe('renderFromRecord — variable substitution', () => {
	test('replaces __PROJECT__, __COMPAT_DATE__, __AUTH_URL__', () => {
		const record = {
			'base/wrangler.jsonc':
				'{ "name": "__PROJECT__-web", "compatibility_date": "__COMPAT_DATE__" }',
			'base/auth-client.ts': "export const url = '__AUTH_URL__'\n"
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: {
				__PROJECT__: 'demo',
				__COMPAT_DATE__: '2026-04-01',
				__AUTH_URL__: 'http://127.0.0.1:8787'
			}
		})
		const wrangler = entries.find((e) => e.path === 'apps/web/wrangler.jsonc')!
		expect(wrangler.content).toBe('{ "name": "demo-web", "compatibility_date": "2026-04-01" }')
		const client = entries.find((e) => e.path === 'apps/web/auth-client.ts')!
		expect(client.content).toBe("export const url = 'http://127.0.0.1:8787'\n")
	})

	test('only `__VAR__` style placeholders are substituted; `${...}` is left alone', () => {
		const record = {
			'base/x.ts': "const a = '__PROJECT__'\nconst b = `${literal}`\n"
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: { __PROJECT__: 'demo' }
		})
		expect(entries[0]!.content).toBe("const a = 'demo'\nconst b = `${literal}`\n")
	})

	test('substitution applies inside fragments as well', () => {
		const record = {
			'package.json.fragments/base.json': JSON.stringify({ name: '@__PROJECT__/web' })
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: { __PROJECT__: 'demo' }
		})
		const pkg = entries.find((e) => e.path === 'apps/web/package.json')!
		const parsed = JSON.parse(pkg.content) as { name: string }
		expect(parsed.name).toBe('@demo/web')
	})

	test('unset variables are left as-is', () => {
		const record = { 'base/x.ts': 'const a = "__UNSET__"\n' }
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: {},
			vars: { __PROJECT__: 'demo' }
		})
		expect(entries[0]!.content).toBe('const a = "__UNSET__"\n')
	})
})

describe('renderFromRecord — overlay flag naming', () => {
	test('hyphenated overlay names map to camelCase flags (i18n-paraglide → i18nParaglide)', () => {
		const record = {
			'base/keep.txt': 'always',
			'overlays/i18n-paraglide/src/i18n.ts': 'enabled',
			'overlays/monitoring-posthog/src/posthog.ts': 'enabled'
		}
		const entries = renderFromRecord({
			record,
			pathPrefix: 'apps/web/',
			flags: { i18nParaglide: true, monitoringPosthog: false },
			vars: {}
		})
		const paths = entries.map((e) => e.path)
		expect(paths).toContain('apps/web/src/i18n.ts')
		expect(paths).not.toContain('apps/web/src/posthog.ts')
	})
})
