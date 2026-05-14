import { siteConfig } from '$lib/config/site'
import type { RequestHandler } from './$types'

const ROUTES = ['/'] as const

export const GET: RequestHandler = () => {
	const urls = ROUTES.map(
		(path) => `<url><loc>${siteConfig.url}${path}</loc></url>`
	).join('')
	const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
	return new Response(xml, {
		headers: { 'content-type': 'application/xml; charset=utf-8' }
	})
}
