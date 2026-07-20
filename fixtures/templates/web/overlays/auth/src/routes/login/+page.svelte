<script lang="ts">
	/*@gvkit:if authEmailOtp*/
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	/*@gvkit:endif*/
	import MailIcon from '@lucide/svelte/icons/mail'
	/*@gvkit:if authEmailOtp*/
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check'
	import { turnstile } from '@svelte-put/cloudflare-turnstile'
	/*@gvkit:endif*/
	import * as Button from '@repo/ui/primitives/button'
	import * as Card from '@repo/ui/primitives/card'
	/*@gvkit:if authEmailOtp*/
	import * as Form from '@repo/ui/primitives/form'
	import * as Input from '@repo/ui/primitives/input'
	import * as InputOTP from '@repo/ui/primitives/input-otp'
	import { REGEXP_ONLY_DIGITS } from 'bits-ui'
	/*@gvkit:endif*/
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	/*@gvkit:endif*/
	/*@gvkit:if authEmailOtp*/
	import { toast } from 'svelte-sonner'
	/*@gvkit:endif*/
	import { /*@gvkit:if authEmailOtp*/fieldProxy, setError, /*@gvkit:endif*/superForm } from 'sveltekit-superforms'
	import { zodClient } from 'sveltekit-superforms/adapters'

	/*@gvkit:if authEmailOtp*/
	import { goto } from '$app/navigation'
	/*@gvkit:endif*/
	import { authClient } from '$lib/auth/client'
	import Seo from '$lib/components/seo.svelte'
	import { loginWizardSchema } from '$lib/schemas/auth'

	let { data } = $props()

	/*@gvkit:if authEmailOtp*/
	let turnstileResetKey = $state(0)
	/*@gvkit:endif*/

	// svelte-ignore state_referenced_locally
	const sf = superForm(data.form, {
		validators: zodClient(loginWizardSchema),
		SPA: true,
		resetForm: false,
		onUpdate: async ({ form }) => {
			if (!form.valid) return

			/*@gvkit:if authEmailOtp*/
			if (form.data.step === 'send') {
				const { email, turnstileToken } = form.data
				const res = await authClient.emailOtp.sendVerificationOtp({
					email,
					type: 'sign-in',
					fetchOptions: { headers: { 'x-captcha-response': turnstileToken } }
				})
				if (res.error) {
					const text = res.error.message ?? ''
					if (/captcha|turnstile/i.test(text)) {
						setError(form, 'turnstileToken', /*@gvkit:if i18nParaglide*/m.auth_verification_failed()/*@gvkit:else*/'Verification failed — please try again'/*@gvkit:endif*/)
						resetTurnstile()
						return
					}
					if (res.error.status === 429) {
						toast.error(/*@gvkit:if i18nParaglide*/m.auth_otp_too_many_requests()/*@gvkit:else*/'Too many requests. Try again in a minute.'/*@gvkit:endif*/)
						return
					}
					toast.error(/*@gvkit:if i18nParaglide*/m.auth_otp_send_failed()/*@gvkit:else*/'Could not send code. Please try again.'/*@gvkit:endif*/)
					resetTurnstile()
					return
				}
				$formData = { step: 'verify', email, code: '' }
				$turnstileTokenProxy = ''
				toast.success(/*@gvkit:if i18nParaglide*/m.auth_otp_send_success()/*@gvkit:else*/'Code sent. Check your inbox.'/*@gvkit:endif*/)
				return
			}

			const { email, code } = form.data
			const res = await authClient.signIn.emailOtp({ email, otp: code })
			if (res.error) {
				setError(form, 'code', /*@gvkit:if i18nParaglide*/m.auth_otp_invalid_code()/*@gvkit:else*/'Invalid or expired code'/*@gvkit:endif*/)
				return
			}
			await goto('/me')
			/*@gvkit:endif*/
		}
	})
	const { form: formData, /*@gvkit:if authEmailOtp*/errors, /*@gvkit:endif*/enhance/*@gvkit:if authEmailOtp*/, submitting/*@gvkit:endif*/ } = sf

	/*@gvkit:if authEmailOtp*/
	const codeProxy = fieldProxy(sf, 'code')
	const turnstileTokenProxy = fieldProxy(sf, 'turnstileToken')
	/*@gvkit:endif*/

	/*@gvkit:if authEmailOtp*/
	function resetTurnstile() {
		$turnstileTokenProxy = ''
		turnstileResetKey += 1
	}

	function useDifferentEmail() {
		$formData = { step: 'send', email: '', turnstileToken: '' }
		resetTurnstile()
	}
	/*@gvkit:endif*/

	async function continueWithGoogle() {
		await authClient.signIn.social({ provider: 'google', callbackURL: '/me' })
	}
</script>

<Seo
	/*@gvkit:if i18nParaglide*/
	title={m.auth_signin()}
	/*@gvkit:else*/
	title="Sign in"
	/*@gvkit:endif*/
/>

<main class="flex min-h-dvh items-center justify-center px-4 py-12">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title class="flex items-center gap-2 text-xl">
				{#if $formData.step === 'send'}
					<MailIcon class="text-primary size-5" aria-hidden="true" />
					<!--@gvkit:if i18nParaglide-->{m.auth_signin()}<!--@gvkit:else-->Sign in<!--@gvkit:endif-->
				<!--@gvkit:if authEmailOtp-->
				{:else}
					<ShieldCheckIcon class="text-primary size-5" aria-hidden="true" />
					<!--@gvkit:if i18nParaglide-->{m.auth_enter_code()}<!--@gvkit:else-->Enter your code<!--@gvkit:endif-->
				<!--@gvkit:endif-->
				{/if}
			</Card.Title>
			<!--@gvkit:if authEmailOtp-->
			<Card.Description>
				{#if $formData.step === 'send'}
					<!--@gvkit:if i18nParaglide-->{m.auth_otp_lede()}<!--@gvkit:else-->No password. We'll email you a 6-digit code.<!--@gvkit:endif-->
				{:else}
					<!--@gvkit:if i18nParaglide-->{m.auth_otp_sent_to_prefix()}<!--@gvkit:else-->Sent to<!--@gvkit:endif-->
					<span class="text-foreground font-medium">{$formData.email}</span>.
				{/if}
			</Card.Description>
			<!--@gvkit:endif-->
		</Card.Header>

		<form method="POST" use:enhance>
			<input type="hidden" name="step" value={$formData.step} />

			{#if $formData.step === 'send'}
				<Card.Content class="space-y-4">
					<!--@gvkit:if authEmailOtp-->
					<Form.Field form={sf} name="email">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>
									<!--@gvkit:if i18nParaglide-->{m.auth_email_label()}<!--@gvkit:else-->Email<!--@gvkit:endif-->
								</Form.Label>
								<Input.Root
									{...props}
									type="email"
									autocomplete="email"
									placeholder="you@example.com"
									bind:value={$formData.email}
								/>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors />
					</Form.Field>

					<input type="hidden" name="turnstileToken" value={$turnstileTokenProxy} />

					{#if data.turnstileSiteKey}
						<div class="flex justify-center">
							{#key turnstileResetKey}
								<div
									use:turnstile
									turnstile-sitekey={data.turnstileSiteKey}
									turnstile-theme="auto"
									onturnstile={(e) => ($turnstileTokenProxy = e.detail.token)}
									onturnstileexpired={() => ($turnstileTokenProxy = '')}
									onturnstileerror={() => ($turnstileTokenProxy = '')}
								></div>
							{/key}
						</div>
					{:else}
						<p class="text-muted-foreground text-center text-xs">
							<!--@gvkit:if i18nParaglide-->{m.auth_turnstile_missing()}<!--@gvkit:else-->Verification key not configured. Set <code>PUBLIC_TURNSTILE_SITE_KEY</code> before deploy.<!--@gvkit:endif-->
						</p>
					{/if}
					{#if $errors.turnstileToken}
						<p class="text-destructive text-sm" role="alert">{$errors.turnstileToken[0]}</p>
					{/if}

					<Form.Button
						class="w-full"
						aria-disabled={$submitting ||
							!$formData.email ||
							(!!data.turnstileSiteKey && !$turnstileTokenProxy)}
						onclick={(e) => {
							if (
								$submitting ||
								!$formData.email ||
								(!!data.turnstileSiteKey && !$turnstileTokenProxy)
							)
								e.preventDefault()
						}}
					>
						{#if $submitting}<Loader2Icon class="mr-2 size-4 animate-spin" aria-hidden="true" />{/if}
						<!--@gvkit:if i18nParaglide-->{m.auth_send_code()}<!--@gvkit:else-->Send code<!--@gvkit:endif-->
					</Form.Button>
					<!--@gvkit:endif-->

					<!--@gvkit:if authEmailOtpAndGoogle-->
					<div class="relative my-2">
						<div class="absolute inset-0 flex items-center">
							<span class="border-border w-full border-t"></span>
						</div>
						<div class="relative flex justify-center text-xs tracking-wider uppercase">
							<span class="bg-card text-muted-foreground px-2">
								<!--@gvkit:if i18nParaglide-->{m.auth_or()}<!--@gvkit:else-->or<!--@gvkit:endif-->
							</span>
						</div>
					</div>
					<!--@gvkit:endif-->
					<!--@gvkit:if authGoogle-->
					<Button.Root
						variant="outline"
						type="button"
						class="w-full"
						onclick={continueWithGoogle}
					>
						<!--@gvkit:if i18nParaglide-->{m.auth_continue_google()}<!--@gvkit:else-->Continue with Google<!--@gvkit:endif-->
					</Button.Root>
					<!--@gvkit:endif-->
				</Card.Content>
			<!--@gvkit:if authEmailOtp-->
			{:else}
				<Card.Content class="space-y-4">
					<input type="hidden" name="email" value={$formData.email} />

					<Form.Field form={sf} name="code">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label class="sr-only">
									<!--@gvkit:if i18nParaglide-->{m.auth_otp_code_label()}<!--@gvkit:else-->6-digit code<!--@gvkit:endif-->
								</Form.Label>
								<InputOTP.Root
									{...props}
									maxlength={6}
									pattern={REGEXP_ONLY_DIGITS}
									bind:value={$codeProxy}
									class="justify-center"
								>
									{#snippet children({ cells })}
										<InputOTP.Group>
											{#each cells.slice(0, 3) as cell (cell)}
												<InputOTP.Slot {cell} />
											{/each}
										</InputOTP.Group>
										<InputOTP.Separator />
										<InputOTP.Group>
											{#each cells.slice(3) as cell (cell)}
												<InputOTP.Slot {cell} />
											{/each}
										</InputOTP.Group>
									{/snippet}
								</InputOTP.Root>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors class="text-center" />
					</Form.Field>

					<Form.Button
						class="w-full"
						aria-disabled={$submitting || $codeProxy.length !== 6}
						onclick={(e) => {
							if ($submitting || $codeProxy.length !== 6) e.preventDefault()
						}}
					>
						{#if $submitting}<Loader2Icon class="mr-2 size-4 animate-spin" aria-hidden="true" />{/if}
						<!--@gvkit:if i18nParaglide-->{m.auth_verify_signin()}<!--@gvkit:else-->Verify and sign in<!--@gvkit:endif-->
					</Form.Button>

					<Button.Root variant="ghost" type="button" class="w-full" onclick={useDifferentEmail}>
						<!--@gvkit:if i18nParaglide-->{m.auth_use_different_email()}<!--@gvkit:else-->Use a different email<!--@gvkit:endif-->
					</Button.Root>
				</Card.Content>
			<!--@gvkit:endif-->
			{/if}
		</form>
	</Card.Root>
</main>
