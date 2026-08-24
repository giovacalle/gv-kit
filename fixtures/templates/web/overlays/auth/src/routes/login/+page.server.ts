/*@gvkit:if authEmailOtp*/
import { PUBLIC_TURNSTILE_SITE_KEY } from '$env/static/public'
/*@gvkit:endif*/
import { redirect } from '@sveltejs/kit'
import { superValidate } from 'sveltekit-superforms/server'
import { zod } from 'sveltekit-superforms/adapters'

import { loginWizardSchema, type LoginMessage, type LoginWizard } from '$lib/schemas/auth'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) throw redirect(303, '/me')
	const form = await superValidate<LoginWizard, LoginMessage>(zod(loginWizardSchema), {
		defaults: { step: 'send', email: '', turnstileToken: '' }
	})
	/*@gvkit:if authEmailOtp*/
	return { form, turnstileSiteKey: PUBLIC_TURNSTILE_SITE_KEY }
	/*@gvkit:else*/
	return { form }
	/*@gvkit:endif*/
}
