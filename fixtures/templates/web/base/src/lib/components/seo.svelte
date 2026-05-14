<script lang="ts">
	import { page } from '$app/state'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	import { getLocale } from '@repo/i18n/runtime'
	/*@gvkit:endif*/

	import { siteConfig } from '$lib/config/site'

	type Props = {
		title?: string
		description?: string
		ogType?: 'website' | 'article'
		image?: string
	}

	let {
		title,
		description,
		ogType = 'website',
		image
	}: Props = $props()

	const resolvedTitle = $derived(title ?? siteConfig.name)
	/*@gvkit:if i18nParaglide*/
	const resolvedDescription = $derived(description ?? m.site_description())
	const resolvedLocale = $derived(getLocale())
	/*@gvkit:else*/
	const resolvedDescription = $derived(
		description ?? 'Type-safe full-stack SvelteKit + Hono on Cloudflare Workers'
	)
	const resolvedLocale = 'en'
	/*@gvkit:endif*/

	const canonical = $derived(`${siteConfig.url}${page.url.pathname}`)
	const resolvedImage = $derived(image ?? `${siteConfig.url}${siteConfig.defaultOgImage}`)
</script>

<svelte:head>
	<title>{resolvedTitle}</title>
	<meta name="description" content={resolvedDescription} />
	<link rel="canonical" href={canonical} />

	<meta property="og:type" content={ogType} />
	<meta property="og:title" content={resolvedTitle} />
	<meta property="og:description" content={resolvedDescription} />
	<meta property="og:url" content={canonical} />
	<meta property="og:image" content={resolvedImage} />
	<meta property="og:site_name" content={siteConfig.name} />
	<meta property="og:locale" content={resolvedLocale} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:site" content={siteConfig.twitter.site} />
	<meta name="twitter:creator" content={siteConfig.twitter.creator} />
	<meta name="twitter:title" content={resolvedTitle} />
	<meta name="twitter:description" content={resolvedDescription} />
	<meta name="twitter:image" content={resolvedImage} />
</svelte:head>
