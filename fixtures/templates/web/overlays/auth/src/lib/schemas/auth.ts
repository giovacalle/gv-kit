/*@gvkit:if i18nParaglide*/
import * as m from '@repo/i18n/messages'
import { z } from 'zod/v3'

const errorMap: z.ZodErrorMap = (issue, ctx) => {
	if (issue.code === 'invalid_string' && issue.validation === 'email')
		return { message: m.auth_validation_email_invalid() }
	if (issue.code === 'invalid_string' && issue.validation === 'regex')
		return { message: m.auth_validation_otp_invalid() }
	if (issue.code === 'too_small' && issue.path.includes('turnstileToken'))
		return { message: m.auth_validation_turnstile_required() }
	if (issue.code === 'too_small' && issue.path.includes('name'))
		return { message: m.auth_validation_name_required() }
	if (issue.code === 'too_big' && issue.path.includes('name'))
		return { message: m.auth_validation_name_too_long() }
	return { message: ctx.defaultError }
}

export const emailField = z.string({ errorMap }).trim().toLowerCase().email()
export const otpField = z.string({ errorMap }).regex(/^\d{6}$/)
/*@gvkit:else*/
import { z } from 'zod/v3'

export const emailField = z.string().trim().toLowerCase().email('Enter a valid email')
export const otpField = z.string().regex(/^\d{6}$/, 'Code must be 6 digits')
/*@gvkit:endif*/

export const loginWizardSchema = z.discriminatedUnion('step', [
	z.object({
		step: z.literal('send'),
		email: emailField,
		/*@gvkit:if i18nParaglide*/
		turnstileToken: z.string({ errorMap }).min(1)
		/*@gvkit:else*/
		turnstileToken: z.string().min(1, 'Please complete the verification')
		/*@gvkit:endif*/
	}),
	z.object({
		step: z.literal('verify'),
		email: emailField,
		code: otpField
	})
])

export type LoginWizard = z.infer<typeof loginWizardSchema>

export type LoginMessage =
	| { kind: 'advanced'; text: string }
	| { kind: 'error'; text: string }

export const profileSchema = z.object({
	/*@gvkit:if i18nParaglide*/
	name: z.string({ errorMap }).trim().min(1).max(80)
	/*@gvkit:else*/
	name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long')
	/*@gvkit:endif*/
})

export type ProfileForm = z.infer<typeof profileSchema>
