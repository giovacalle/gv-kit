/*@gvkit:if i18nParaglide*/
import type { Locale } from '@repo/i18n/runtime'
/*@gvkit:endif*/
/*@gvkit:if auth*/
import type { authClient } from '$lib/auth/client'

type SessionUser = (typeof authClient.$Infer.Session)['user']
/*@gvkit:endif*/

declare global {
	namespace App {
		interface Locals {
			/*@gvkit:if auth*/
			user: SessionUser | null
			/*@gvkit:endif*/
			/*@gvkit:if i18nParaglide*/
			locale: Locale
			/*@gvkit:endif*/
		}
		interface Platform {
			/*@gvkit:if honoGatewayCfWorkers*/
			env: Env
			/*@gvkit:endif*/
			/*@gvkit:if deployNode*/
			env: {
				/*@gvkit:if honoGateway*/
				__GATEWAY_TARGET__?: Fetcher
				/*@gvkit:endif*/
			}
			/*@gvkit:endif*/
			/*@gvkit:if insideFrontendCfWorkers*/
			env: {}
			/*@gvkit:endif*/
		}
	}
	namespace NodeJS {
		interface ProcessEnv {
			/*@gvkit:if insideFrontend*/
			PUBLIC_AUTH_URL: string
			/*@gvkit:endif*/
			/*@gvkit:if authEmailOtp*/
			PUBLIC_TURNSTILE_SITE_KEY: string
			/*@gvkit:endif*/
		}
	}
}

export {}
