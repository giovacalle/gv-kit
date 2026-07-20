import { marketingTemplates } from '../generated/marketing-templates.js'
import { rootTemplates } from '../generated/root-templates.js'
import { uiTemplates } from '../generated/ui-templates.js'
import { webTemplates } from '../generated/web-templates.js'
import type { FileEntry } from './files.js'

export interface RenderInput {
	tree: 'root' | 'web' | 'ui' | 'marketing'
	flags: Record<string, boolean>
	vars: Record<string, string>
}

export interface RenderFromRecordInput {
	record: Record<string, string>
	pathPrefix: string
	flags: Record<string, boolean>
	vars: Record<string, string>
}

const TREE_PREFIX: Record<RenderInput['tree'], string> = {
	root: '',
	web: 'apps/web/',
	ui: 'packages/ui/',
	marketing: 'apps/marketing/'
}

const TREE_RECORD: Record<RenderInput['tree'], Record<string, string>> = {
	root: rootTemplates,
	web: webTemplates,
	ui: uiTemplates,
	marketing: marketingTemplates
}

const BASE_PREFIX = 'base/'
const OVERLAY_PREFIX = 'overlays/'
const FRAGMENT_PREFIX = 'package.json.fragments/'
const PACKAGE_JSON_PATH = 'package.json'

export function renderTemplate(input: RenderInput): FileEntry[] {
	return renderFromRecord({
		record: TREE_RECORD[input.tree],
		pathPrefix: TREE_PREFIX[input.tree],
		flags: input.flags,
		vars: input.vars
	})
}

export function renderFromRecord(input: RenderFromRecordInput): FileEntry[] {
	const { record, pathPrefix, flags, vars } = input
	const enabledOverlays = collectEnabledOverlays(record, flags)

	const fileMap = new Map<string, string>()
	const fragments: string[] = []

	for (const [key, content] of Object.entries(record)) {
		if (key.startsWith(BASE_PREFIX)) {
			const relPath = key.slice(BASE_PREFIX.length)
			if (relPath === PACKAGE_JSON_PATH) continue
			fileMap.set(relPath, content)
		}
	}

	for (const overlay of enabledOverlays) {
		const overlayPrefix = `${OVERLAY_PREFIX}${overlay}/`
		for (const [key, content] of Object.entries(record)) {
			if (key.startsWith(overlayPrefix)) {
				const relPath = key.slice(overlayPrefix.length)
				if (relPath === PACKAGE_JSON_PATH) continue
				fileMap.set(relPath, content)
			}
		}
	}

	const baseFragmentKey = `${FRAGMENT_PREFIX}base.json`
	if (record[baseFragmentKey] !== undefined) fragments.push(record[baseFragmentKey])
	for (const overlay of enabledOverlays) {
		const fragmentKey = `${FRAGMENT_PREFIX}${overlay}.json`
		if (record[fragmentKey] !== undefined) fragments.push(record[fragmentKey])
	}

	const entries: FileEntry[] = []

	for (const [relPath, rawContent] of fileMap) {
		const stripped = stripFences(rawContent, flags)
		const substituted = substituteVars(stripped, vars)
		entries.push({ path: pathPrefix + relPath, content: substituted })
	}

	if (fragments.length > 0) {
		const merged = mergePackageFragments(fragments, vars)
		if (merged !== null) {
			entries.push({ path: pathPrefix + PACKAGE_JSON_PATH, content: merged })
		}
	}

	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	return entries
}

function collectEnabledOverlays(
	record: Record<string, string>,
	flags: Record<string, boolean>
): string[] {
	const seen = new Set<string>()
	for (const key of Object.keys(record)) {
		if (key.startsWith(OVERLAY_PREFIX)) {
			const rest = key.slice(OVERLAY_PREFIX.length)
			const slash = rest.indexOf('/')
			if (slash > 0) seen.add(rest.slice(0, slash))
		}
	}
	const fragmentNames = Object.keys(record)
		.filter((k) => k.startsWith(FRAGMENT_PREFIX))
		.map((k) => k.slice(FRAGMENT_PREFIX.length).replace(/\.json$/, ''))
	for (const name of fragmentNames) if (name !== 'base') seen.add(name)

	return [...seen].filter((name) => flags[overlayFlagKey(name)] === true).sort()
}

// `auth` overlay is gated by `flags.auth`; `monitoring-posthog` by `flags.monitoringPosthog`.
function overlayFlagKey(name: string): string {
	return name.replace(/-([a-z])/g, (_match, ch: string) => ch.toUpperCase())
}

// Tempered greedy tokens match anything that is NOT the start of a fence
// directive — this makes the if/else/endif regex match only INNERMOST fences,
// so the iterative pass below can collapse a nest from inside out.
//
// Each directive has two variants alternated explicitly:
//   own-line: `(?<=^|\n)[ \t]*<DIRECTIVE>[ \t]*\n`  — eats indentation + EOL
//   mid-line: `<DIRECTIVE>`                          — eats only the marker
// Coupling the two ends in the own-line variant prevents the trailing newline
// from being stolen when the directive sits in the middle of a line.
const FENCE_BLOCK_HTML_RE =
	/(?:(?<=^|\n)[ \t]*<!--@gvkit:if\s+([A-Za-z0-9_]+)-->[ \t]*\n|<!--@gvkit:if\s+([A-Za-z0-9_]+)-->)((?:(?!<!--@gvkit:(?:if\s+[A-Za-z0-9_]+|else|endif)-->)[\s\S])*?)(?:(?:(?<=^|\n)[ \t]*<!--@gvkit:else-->[ \t]*\n|<!--@gvkit:else-->)((?:(?!<!--@gvkit:(?:if\s+[A-Za-z0-9_]+|else|endif)-->)[\s\S])*?))?(?:(?<=^|\n)[ \t]*<!--@gvkit:endif-->[ \t]*\n|<!--@gvkit:endif-->)/g

const FENCE_BLOCK_TS_RE =
	/(?:(?<=^|\n)[ \t]*\/\*@gvkit:if\s+([A-Za-z0-9_]+)\*\/[ \t]*\n|\/\*@gvkit:if\s+([A-Za-z0-9_]+)\*\/)((?:(?!\/\*@gvkit:(?:if\s+[A-Za-z0-9_]+|else|endif)\*\/)[\s\S])*?)(?:(?:(?<=^|\n)[ \t]*\/\*@gvkit:else\*\/[ \t]*\n|\/\*@gvkit:else\*\/)((?:(?!\/\*@gvkit:(?:if\s+[A-Za-z0-9_]+|else|endif)\*\/)[\s\S])*?))?(?:(?<=^|\n)[ \t]*\/\*@gvkit:endif\*\/[ \t]*\n|\/\*@gvkit:endif\*\/)/g

const STRIP_LINE_RE = /^(.*?)[ \t]*\/\/\s*@gvkit:strip-without\s+([A-Za-z0-9_]+)[^\n]*(\r?\n)?/gm

function stripFences(content: string, flags: Record<string, boolean>): string {
	// The opening directive's alternation produces two flag capture slots — one
	// for the own-line branch, one for the mid-line branch. Exactly one will be
	// defined per match; coalesce here so the body only deals with one flag.
	const replaceFenceBlock = (
		_full: string,
		ownLineFlag: string | undefined,
		midLineFlag: string | undefined,
		ifBlock: string,
		elseBlock: string | undefined
	): string => {
		const flag = ownLineFlag ?? midLineFlag ?? ''
		return flags[flag] === true ? ifBlock : (elseBlock ?? '')
	}

	let out = content
	let prev: string
	do {
		prev = out
		out = out.replace(FENCE_BLOCK_HTML_RE, replaceFenceBlock)
		out = out.replace(FENCE_BLOCK_TS_RE, replaceFenceBlock)
	} while (out !== prev)

	out = out.replace(
		STRIP_LINE_RE,
		(_match, prefix: string, flag: string, eol: string | undefined) => {
			const ending = eol ?? ''
			if (flags[flag] !== true) return ''
			if (prefix.length === 0) return ''
			return prefix + ending
		}
	)

	return out
}

function substituteVars(content: string, vars: Record<string, string>): string {
	let out = content
	for (const [key, value] of Object.entries(vars)) {
		if (!key.startsWith('__') || !key.endsWith('__')) continue
		out = out.split(key).join(value)
	}
	return out
}

function mergePackageFragments(fragments: string[], vars: Record<string, string>): string | null {
	const parsed = fragments.map((raw, i) => {
		try {
			return JSON.parse(substituteVars(raw, vars)) as Record<string, unknown>
		} catch (err) {
			throw new Error(
				`bundle-templates: package.json fragment ${i} is not valid JSON: ${(err as Error).message}`
			)
		}
	})

	if (parsed.length === 0) return null

	const merged: Record<string, unknown> = {}
	for (const fragment of parsed) deepMerge(merged, fragment)

	return JSON.stringify(sortKeysDeep(merged), null, 2) + '\n'
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		const current = target[key]
		if (isPlainObject(current) && isPlainObject(value)) {
			deepMerge(current, value)
		} else {
			target[key] = value
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const PACKAGE_JSON_KEY_ORDER = [
	'name',
	'version',
	'description',
	'private',
	'type',
	'license',
	'author',
	'main',
	'module',
	'svelte',
	'types',
	'bin',
	'exports',
	'files',
	'engines',
	'scripts',
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
	'overrides'
]

function sortKeysDeep(value: unknown, depth = 0): unknown {
	if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v, depth + 1))
	if (!isPlainObject(value)) return value

	const entries = Object.entries(value)
	const ordered: [string, unknown][] = []
	if (depth === 0) {
		const known = new Set(PACKAGE_JSON_KEY_ORDER)
		for (const k of PACKAGE_JSON_KEY_ORDER) {
			const found = entries.find(([key]) => key === k)
			if (found) ordered.push([found[0], sortKeysDeep(found[1], depth + 1)])
		}
		const rest = entries.filter(([k]) => !known.has(k)).sort((a, b) => (a[0] < b[0] ? -1 : 1))
		for (const [k, v] of rest) ordered.push([k, sortKeysDeep(v, depth + 1)])
	} else {
		const sorted = entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1))
		for (const [k, v] of sorted) ordered.push([k, sortKeysDeep(v, depth + 1)])
	}

	const result: Record<string, unknown> = {}
	for (const [k, v] of ordered) result[k] = v
	return result
}
