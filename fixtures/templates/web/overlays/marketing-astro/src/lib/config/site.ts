import { PUBLIC_APP_URL } from '$env/static/public'

export const siteConfig = {
	name: '__PROJECT__',
	url: PUBLIC_APP_URL,
	defaultOgImage: '/og-image.png',
	twitter: { site: '@example', creator: '@example' }
} as const

export type SiteConfig = typeof siteConfig
