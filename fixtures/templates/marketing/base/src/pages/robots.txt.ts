import type { APIRoute } from 'astro'

export const GET: APIRoute = ({ site }) => {
	if (!site) throw new Error('PUBLIC_MARKETING_URL is required for robots.txt')
	const sitemap = new URL('/sitemap-index.xml', site)
	const body = `User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`
	return new Response(body, {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	})
}
