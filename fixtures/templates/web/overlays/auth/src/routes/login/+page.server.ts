import { redirect } from '@sveltejs/kit'
import { superValidate } from 'sveltekit-superforms'
import { zod } from 'sveltekit-superforms/adapters'

import { loginWizardSchema, type LoginMessage, type LoginWizard } from '$lib/schemas/auth'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (locals.user) throw redirect(303, '/me')
	const form = await superValidate<LoginWizard, LoginMessage>(zod(loginWizardSchema), {
		defaults: { step: 'send', email: '', turnstileToken: '' }
	})
	const turnstileSiteKey =
		(platform?.env as { PUBLIC_TURNSTILE_SITE_KEY?: string } | undefined)
			?.PUBLIC_TURNSTILE_SITE_KEY ?? ''
	return { form, turnstileSiteKey }
}
