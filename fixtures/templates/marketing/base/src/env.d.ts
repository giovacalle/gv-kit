/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly PUBLIC_MARKETING_URL: string
	readonly PUBLIC_APP_URL: string
	readonly PUBLIC_UMAMI_HOST?: string
	readonly PUBLIC_UMAMI_WEBSITE_ID?: string
	readonly PUBLIC_POSTHOG_KEY?: string
	readonly PUBLIC_POSTHOG_HOST?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
