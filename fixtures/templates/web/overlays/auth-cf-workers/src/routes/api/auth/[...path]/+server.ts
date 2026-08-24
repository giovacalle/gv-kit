import type { RequestHandler } from './$types'

const proxy: RequestHandler = async ({ platform, request }) => {
	const auth = platform?.env.AUTH
	if (!auth) return new Response('Auth service unavailable', { status: 503 })
	return auth.fetch(request)
}

export const GET = proxy
export const POST = proxy
export const OPTIONS = proxy
