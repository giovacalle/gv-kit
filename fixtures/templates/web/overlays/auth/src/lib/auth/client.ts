import { PUBLIC_AUTH_URL } from '$env/static/public'
/*@gvkit:if authEmailOtp*/
import { emailOTPClient } from 'better-auth/client/plugins'
/*@gvkit:endif*/
import { createAuthClient } from 'better-auth/svelte'

export const authClient = createAuthClient({
	baseURL: PUBLIC_AUTH_URL/*@gvkit:if authEmailOtp*/,
	plugins: [emailOTPClient()]
	/*@gvkit:endif*/
})

export type Session = typeof authClient.$Infer.Session
