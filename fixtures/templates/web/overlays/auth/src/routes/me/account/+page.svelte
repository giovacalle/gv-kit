<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import LogOutIcon from '@lucide/svelte/icons/log-out'
	import Trash2Icon from '@lucide/svelte/icons/trash-2'
	import * as AlertDialog from '@repo/ui/primitives/alert-dialog'
	import * as Button from '@repo/ui/primitives/button'
	import * as Card from '@repo/ui/primitives/card'
	import * as Form from '@repo/ui/primitives/form'
	import * as Input from '@repo/ui/primitives/input'
	import Seo from '$lib/components/seo.svelte'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	/*@gvkit:endif*/
	import { toast } from 'svelte-sonner'
	import { superForm } from 'sveltekit-superforms/client'
	import { zodClient } from 'sveltekit-superforms/adapters'

	import { authClient } from '$lib/auth/client'
	import { getAuthContext } from '$lib/context/auth-context.svelte'
	import { profileSchema } from '$lib/schemas/auth'

	let { data } = $props()

	const auth = getAuthContext()

	// svelte-ignore state_referenced_locally
	const sf = superForm(data.form, {
		validators: zodClient(profileSchema),
		SPA: true,
		resetForm: false,
		onUpdate: async ({ form }) => {
			if (!form.valid) return
			const res = await authClient.updateUser({ name: form.data.name })
			if (res.error) {
				toast.error(/*@gvkit:if i18nParaglide*/m.account_update_failed()/*@gvkit:else*/'Could not update profile.'/*@gvkit:endif*/)
				return
			}
			toast.success(/*@gvkit:if i18nParaglide*/m.account_update_success()/*@gvkit:else*/'Profile updated.'/*@gvkit:endif*/)
		}
	})
	const { form: formData, enhance, submitting } = sf

	let deleteOpen = $state(false)
	let deleting = $state(false)

	async function handleDelete() {
		deleting = true
		const res = await authClient.deleteUser()
		if (res.error) {
			toast.error(/*@gvkit:if i18nParaglide*/m.account_delete_failed()/*@gvkit:else*/'Could not delete account.'/*@gvkit:endif*/)
			deleting = false
			deleteOpen = false
			return
		}
		toast.success(/*@gvkit:if i18nParaglide*/m.account_delete_success()/*@gvkit:else*/'Account deleted.'/*@gvkit:endif*/)
		location.assign('/')
	}
</script>

<Seo
	/*@gvkit:if i18nParaglide*/
	title={m.account_title()}
	/*@gvkit:else*/
	title="Account"
	/*@gvkit:endif*/
/>

<header class="mb-8">
	<h1 class="text-3xl font-semibold tracking-tight">
		<!--@gvkit:if i18nParaglide-->{m.account_title()}<!--@gvkit:else-->Account<!--@gvkit:endif-->
	</h1>
	<p class="text-muted-foreground mt-2">
		<!--@gvkit:if i18nParaglide-->{m.account_lede()}<!--@gvkit:else-->Manage your profile and session.<!--@gvkit:endif-->
	</p>
</header>

<div class="space-y-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>
				<!--@gvkit:if i18nParaglide-->{m.account_profile_title()}<!--@gvkit:else-->Profile<!--@gvkit:endif-->
			</Card.Title>
			<Card.Description>
				<!--@gvkit:if i18nParaglide-->{m.account_profile_desc()}<!--@gvkit:else-->Your display name. Email is set at sign-in time.<!--@gvkit:endif-->
			</Card.Description>
		</Card.Header>
		<form method="POST" use:enhance>
			<Card.Content class="space-y-4">
				<Form.Field form={sf} name="name">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>
								<!--@gvkit:if i18nParaglide-->{m.account_name_label()}<!--@gvkit:else-->Name<!--@gvkit:endif-->
							</Form.Label>
							<Input.Root {...props} bind:value={$formData.name} />
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>

				<dl class="text-sm">
					<dt class="text-muted-foreground">
						<!--@gvkit:if i18nParaglide-->{m.account_email_label()}<!--@gvkit:else-->Email<!--@gvkit:endif-->
					</dt>
					<dd>{data.user.email}</dd>
				</dl>
			</Card.Content>
			<Card.Footer>
				<Form.Button
					aria-disabled={$submitting}
					onclick={(e) => {
						if ($submitting) e.preventDefault()
					}}
				>
					{#if $submitting}<Loader2Icon class="mr-2 size-4 animate-spin" aria-hidden="true" />{/if}
					<!--@gvkit:if i18nParaglide-->{m.account_save()}<!--@gvkit:else-->Save changes<!--@gvkit:endif-->
				</Form.Button>
			</Card.Footer>
		</form>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>
				<!--@gvkit:if i18nParaglide-->{m.account_session_title()}<!--@gvkit:else-->Session<!--@gvkit:endif-->
			</Card.Title>
			<Card.Description>
				<!--@gvkit:if i18nParaglide-->{m.account_session_desc()}<!--@gvkit:else-->Sign out of this browser.<!--@gvkit:endif-->
			</Card.Description>
		</Card.Header>
		<Card.Footer>
			<Button.Root variant="outline" onclick={auth.signOut}>
				<LogOutIcon class="size-4" aria-hidden="true" />
				<!--@gvkit:if i18nParaglide-->{m.account_signout()}<!--@gvkit:else-->Sign out<!--@gvkit:endif-->
			</Button.Root>
		</Card.Footer>
	</Card.Root>

	<Card.Root class="border-destructive/40">
		<Card.Header>
			<Card.Title class="text-destructive">
				<!--@gvkit:if i18nParaglide-->{m.account_delete_title()}<!--@gvkit:else-->Delete account<!--@gvkit:endif-->
			</Card.Title>
			<Card.Description>
				<!--@gvkit:if i18nParaglide-->{m.account_delete_desc()}<!--@gvkit:else-->Permanently remove your account and all associated data. This cannot be undone.<!--@gvkit:endif-->
			</Card.Description>
		</Card.Header>
		<Card.Footer>
			<AlertDialog.Root bind:open={deleteOpen}>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button.Root variant="destructive" {...props}>
							<Trash2Icon class="size-4" aria-hidden="true" />
							<!--@gvkit:if i18nParaglide-->{m.account_delete_button()}<!--@gvkit:else-->Delete account<!--@gvkit:endif-->
						</Button.Root>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>
							<!--@gvkit:if i18nParaglide-->{m.account_delete_confirm_title()}<!--@gvkit:else-->Delete account?<!--@gvkit:endif-->
						</AlertDialog.Title>
						<AlertDialog.Description>
							<!--@gvkit:if i18nParaglide-->{m.account_delete_confirm_desc()}<!--@gvkit:else-->This will permanently delete your account and all associated data. You cannot recover it once deleted.<!--@gvkit:endif-->
						</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>
							<!--@gvkit:if i18nParaglide-->{m.account_cancel()}<!--@gvkit:else-->Cancel<!--@gvkit:endif-->
						</AlertDialog.Cancel>
						<AlertDialog.Action
							class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							onclick={handleDelete}
							disabled={deleting}
						>
							{#if deleting}<Loader2Icon class="mr-2 size-4 animate-spin" aria-hidden="true" />{/if}
							<!--@gvkit:if i18nParaglide-->{m.account_delete_yes()}<!--@gvkit:else-->Yes, delete<!--@gvkit:endif-->
						</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</Card.Footer>
	</Card.Root>
</div>
