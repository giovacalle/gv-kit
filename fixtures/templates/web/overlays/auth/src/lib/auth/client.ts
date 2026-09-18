/*@gvkit:if insideFrontend*/
import { PUBLIC_AUTH_URL } from '$env/static/public'
/*@gvkit:endif*/
/*@gvkit:if authEmailOtp*/
import { emailOTPClient } from 'better-auth/client/plugins'
/*@gvkit:endif*/
import { createAuthClient } from 'better-auth/svelte'

export const authClient = createAuthClient({
	/*@gvkit:if insideFrontendAuthEmailOtp*/
	baseURL: PUBLIC_AUTH_URL,
	plugins: [emailOTPClient()]
	/*@gvkit:endif*/
	/*@gvkit:if insideFrontendAuthNoEmailOtp*/
	baseURL: PUBLIC_AUTH_URL
	/*@gvkit:endif*/
	/*@gvkit:if honoAuthEmailOtp*/
	plugins: [emailOTPClient()]
	/*@gvkit:endif*/
})

export type Session = typeof authClient.$Infer.Session
