export const siteConfig = {
	name: '__PROJECT__',
	url: 'https://example.com',
	defaultOgImage: '/og-image.png',
	twitter: { site: '@example', creator: '@example' }
} as const

export type SiteConfig = typeof siteConfig
