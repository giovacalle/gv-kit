# Forms — superforms + zod + formsnap

Every form goes through `sveltekit-superforms` v2 with the `zod` adapter, rendered via `formsnap` v2. The server is the canonical validation boundary. Progressive enhancement comes for free via superforms' `enhance`.

## Stack

| Piece | Source |
|---|---|
| Form orchestration (client) | `superForm` from `sveltekit-superforms` |
| Form validation (server) | `superValidate` from `sveltekit-superforms` |
| Schema adapter | `zod` (server) / `zodClient` (client) from `sveltekit-superforms/adapters` |
| Field wrappers | `* as Form` from `@repo/ui/primitives/form` (formsnap-backed) |
| UI primitives | `@repo/ui/primitives/<name>` (`Input.Root`, `Button.Root`, …) |
| Shared schemas | `src/lib/schemas/<domain>.ts` |
| Field-level failure | `setError(form, 'name', msg, { status })` |
| Form-level failure | `message(form, payload, { status })` |
| Validation short-circuit | `return fail(400, { form })` after `!form.valid` |

## Mandatory contract

Every form MUST:

1. Define its zod schema in `src/lib/schemas/<domain>.ts` (or import an existing one).
2. Call `superValidate(event, zod(schema))` server-side; bail with `fail(400, { form })` on `!form.valid`.
3. Use `superForm(data.form, { validators: zodClient(schema) })` client-side and wrap the `<form>` in `use:enhance` from the destructured returns.
4. Render every visible field through `<Form.Field>` + `<Form.Control>` + `<Form.Label>` + `<Form.FieldErrors />`. No bare `<Input.Root>` without a parent `Form.Field`.
5. Surface form-level failures via `$message` in `onUpdated` (toast or inline).
6. Follow the submit-button pattern (label + spinner, `aria-disabled`, click guard — see "Submit button" below).
7. <!--@gvkit:if i18nParaglide-->Pull copy from `@repo/i18n/messages` via `m.<key>()`; never hardcode English. Field labels and form-level error messages must be message keys.<!--@gvkit:else-->Hardcode English copy. There is no i18n layer.<!--@gvkit:endif-->

## Field structure (the snippet pattern)

```svelte
<script lang="ts">
	import { superForm } from 'sveltekit-superforms';
	import { zodClient } from 'sveltekit-superforms/adapters';

	import * as Form from '@repo/ui/primitives/form';
	import * as Input from '@repo/ui/primitives/input';
	import * as Button from '@repo/ui/primitives/button';

	import { joinSchema } from '$lib/schemas/join';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	const superform = superForm(data.form, {
		validators: zodClient(joinSchema),
		resetForm: false,
		onUpdated({ form }) {
			if (form.message && !form.valid) toast.error(form.message);
		}
	});
	const { form: formData, errors, enhance, submitting, message } = superform;
</script>

<form method="POST" use:enhance>
	<Form.Field form={superform} name="email">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label>Email</Form.Label>
				<Input.Root {...props} type="email" bind:value={$formData.email} />
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>

	{#if $message}
		<p class="text-destructive text-sm" role="alert">{$message}</p>
	{/if}

	<!-- Submit button — see pattern below -->
</form>
```

The `{#snippet children({ props })}` block is REQUIRED — formsnap injects `id`, `aria-describedby`, `aria-invalid` through `props`. Splatting them onto the `Input.Root` is what wires error-state to the field visually and to assistive tech.

## Submit button — original label + spinner, `aria-disabled`, click guard

Never replace the button label with "Loading…". The user must always see which action they kicked off.

Use `aria-disabled` (not `disabled`) so the button stays in the focus order for screen readers, and gate clicks manually:

```svelte
<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import * as Button from '@repo/ui/primitives/button';
</script>

<Button.Root
	type="submit"
	aria-disabled={$submitting}
	onclick={(e) => {
		if ($submitting) e.preventDefault();
	}}
>
	{#if $submitting}
		<Loader2Icon class="mr-2 size-4 animate-spin" aria-hidden="true" />
	{/if}
	Send code
</Button.Root>
```

## Multi-step wizards — single form, single `superForm`, discriminated union schema

For a 2-step flow (e.g. send → verify), use ONE `<form>`, ONE `superForm` instance, and a `z.discriminatedUnion('step', [...])` schema. The server branches on `form.data.step` and flips `form.data` to advance.

```typescript
// src/lib/schemas/wizard.ts
import { z } from 'zod/v3'; // sveltekit-superforms v2 expects v3 types

export const wizardSchema = z.discriminatedUnion('step', [
	z.object({
		step: z.literal('send'),
		email: z.string().email()
	}),
	z.object({
		step: z.literal('verify'),
		email: z.string().email(),
		code: z.string().length(6)
	})
]);
```

Server action:

```typescript
const form = await superValidate(event, zod(wizardSchema));
if (!form.valid) return fail(400, { form });

if (form.data.step === 'send') {
	await sendCode(form.data.email);
	form.data = { step: 'verify', email: form.data.email, code: '' };
	return message(form, { kind: 'advanced', text: 'Code sent.' });
}
// step === 'verify'
throw redirect(303, '/me');
```

Client conditional render keys off `$formData.step`:

```svelte
<form method="POST" use:enhance>
	<input type="hidden" name="step" value={$formData.step} />

	{#if $formData.step === 'send'}
		<!-- email field -->
	{:else}
		<input type="hidden" name="email" value={$formData.email} />
		<!-- code field — use fieldProxy for branch-only fields -->
	{/if}
</form>
```

Key details:
- `$formData` reactive access does NOT narrow across `{#if}` branches. For binding to a branch-only field, use `fieldProxy(superform, 'code')`.
- Reset back to step 1 via whole-object assignment: `$formData = { step: 'send', email: '', }`.
- UI-only state (countdown timer, captcha widget lifecycle) is normal `$state`, not form state.

## Anti-patterns

| Don't | Do |
|---|---|
| `<input type="email" />` directly | `<Input.Root>` inside `<Form.Field>` + `<Form.Control>` snippet |
| Replace submit label with "Loading…" | Keep label, prepend spinner |
| `disabled={$submitting}` | `aria-disabled={$submitting}` + `onclick` preventDefault guard |
| Re-define schemas per route | Single schema in `src/lib/schemas/<domain>.ts`, imported by both server and client |
| `try/catch` around the action body for flow control | `setError` / `message` for inline UX; only `redirect()` throws |
| Two separate `<form>`s for a wizard | Single `<form>`, single `superForm`, discriminated union schema |
