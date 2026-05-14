import { siteConfig } from '$lib/config/site'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = () => {
	const body = `User-agent: *\nAllow: /\n\nSitemap: ${siteConfig.url}/sitemap.xml\n`
	return new Response(body, {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	})
}
