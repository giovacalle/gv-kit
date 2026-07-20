import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Generator for framework-specific monitoring helpers.
 *
 * Multi-select via `cfg.choices.monitoring`. This generator emits ONLY the
 * helper modules — it deliberately does NOT touch:
 *
 *   - `apps/web/src/app.html`     (script tag for umami)            ← frontend-sveltekit.ts
 *   - `apps/web/src/hooks.client.ts` (posthog init)                  ← frontend-sveltekit.ts
 *   - `apps/marketing/src/layouts/base.astro` (script placement)     ← marketing templates
 *
 * That split keeps each generator's path-set disjoint, so the planner can
 * concatenate without conflicts.
 *
 * If the array is empty (user picked nothing), this generator returns [].
 */
export function generateMonitoring(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = []
	const wantsUmami = cfg.choices.monitoring.includes('umami')
	const wantsPosthog = cfg.choices.monitoring.includes('posthog')

	if (wantsUmami) {
		entries.push({
			path: 'apps/web/src/lib/services/umami.ts',
			content: UMAMI_HELPER
		})
	}

	if (wantsPosthog) {
		entries.push({
			path: 'apps/web/src/lib/services/posthog.ts',
			content: POSTHOG_HELPER
		})
		if (cfg.choices.marketing === 'astro') {
			entries.push({
				path: 'apps/marketing/src/scripts/posthog.ts',
				content: MARKETING_POSTHOG
			})
		}
	}

	return entries
}

/* ------------------------------------------------------------------ */
/*  umami helper                                                       */
/* ------------------------------------------------------------------ */

const UMAMI_HELPER = `// Programmatic event tracking for umami. The page-view script tag is
// injected by app.html — this helper is for custom events only.

type UmamiWindow = Window & {
	umami?: {
		track: (event: string, data?: Record<string, unknown>) => void
	}
}

/**
 * Track a custom event. Safe to call before umami has loaded — the call is
 * silently dropped if the global is not yet attached.
 */
export function trackEvent(event: string, data?: Record<string, unknown>): void {
	if (typeof window === 'undefined') return
	const w = window as UmamiWindow
	if (w.umami) w.umami.track(event, data)
}
`

/* ------------------------------------------------------------------ */
/*  posthog helper                                                     */
/* ------------------------------------------------------------------ */

const POSTHOG_HELPER = `// Thin wrapper around posthog-js for custom events. The init call lives in
// hooks.client.ts (emitted by the frontend generator) — this helper assumes
// posthog is already initialised.

import posthog from 'posthog-js'

/**
 * Capture a custom event. Safe in SSR (no-op when window is undefined).
 */
export function capture(event: string, properties?: Record<string, unknown>): void {
	if (typeof window === 'undefined') return
	posthog.capture(event, properties)
}

/**
 * Identify the current user. Call after login.
 */
export function identify(userId: string, traits?: Record<string, unknown>): void {
	if (typeof window === 'undefined') return
	posthog.identify(userId, traits)
}

/**
 * Reset on logout.
 */
export function reset(): void {
	if (typeof window === 'undefined') return
	posthog.reset()
}
`

const MARKETING_POSTHOG = `// Client-only analytics entry imported from an Astro-processed <script>.
// Never import this module from Astro frontmatter: frontmatter executes at build time.
import posthog from 'posthog-js'

const key = import.meta.env.PUBLIC_POSTHOG_KEY
const host = import.meta.env.PUBLIC_POSTHOG_HOST

if (typeof window !== 'undefined' && key && host) {
	posthog.init(key, {
		api_host: host,
		capture_pageview: true,
		capture_pageleave: true,
		person_profiles: 'identified_only'
	})
}
`
