# UI Conventions

Where components live, how they're imported, and the discipline that keeps the UI layer tidy.

## The component map

```
packages/ui/src/lib/components/
├── primitives/                       # shadcn-svelte primitives — workspace-wide
│   ├── button/
│   ├── card/
│   ├── input/
│   ├── form/
│   ├── label/
│   ├── badge/
│   ├── alert-dialog/
│   ├── dropdown-menu/
│   └── ...
└── <composite-name>/                 # generic reusable composites (mode-toggle, etc.)
    └── <composite-name>.svelte

apps/web/src/lib/components/
├── layout/                           # chrome: nav, footer, header, sidebar
│   ├── nav.svelte
│   └── footer.svelte
├── seo.svelte                        # <svelte:head> wrapper — app-local, NOT in @repo/ui
└── <name>.svelte                     # other app-specific composites (flat)
```

| Component type | Location |
|---|---|
| shadcn-svelte primitive (Button, Input, Card, …) | `packages/ui/src/lib/components/primitives/<name>/` |
| Generic reusable composite (used in 2+ apps OR theme-related) | `packages/ui/src/lib/components/<name>/` |
| App chrome (nav, footer, header, sidebar) | `apps/web/src/lib/components/layout/<name>.svelte` |
| SEO wrapper | `apps/web/src/lib/components/seo.svelte` (NEVER in `@repo/ui`) |
| Other app-specific composite | `apps/web/src/lib/components/<name>.svelte` (flat) |
| Page-private composite | `apps/web/src/routes/<path>/_components/<name>.svelte` |

**Primitives MUST NOT live under `apps/web/src/lib/components/ui/`.** That path must not exist anywhere in the app. Every primitive lives in `packages/ui`.

**SEO stays app-local.** The SEO wrapper imports app-level config and `$app/state`. Putting it in `@repo/ui` would couple the package to the SvelteKit runtime — `@repo/ui` must remain importable from any Svelte 5 surface.

## Graduation rule for sub-folders

Default to a flat file inside `apps/web/src/lib/components/`. Promote to a sub-folder only when a logical group owns **3 or more** files used across routes. Example: a payment flow gaining `pricing-card.svelte`, `plan-row.svelte`, `checkout-summary.svelte` → graduate to `components/billing/`.

| Trigger | Action |
|---|---|
| 1–2 related files | Stay flat |
| 3+ files in the same logical group, shared across 2+ routes | New sub-folder `components/<group>/` |
| 3+ files all used by a single route | Move to `routes/<route>/_components/` instead |
| Single page-private use | `routes/<route>/_components/<name>.svelte` from the start |

Don't pre-create empty group folders. Promotion is a refactor with a real trigger, not a setup step.

## Importing primitives

### Namespace barrel (compound APIs)

Most primitives expose a compound API (`.Root`, `.Content`, `.Header`, …). Import as a namespace:

```svelte
<script lang="ts">
	import * as Button from '@repo/ui/primitives/button';
	import * as Card from '@repo/ui/primitives/card';
	import * as Input from '@repo/ui/primitives/input';
	import * as Form from '@repo/ui/primitives/form';
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Title</Card.Title>
	</Card.Header>
	<Card.Content>
		<Form.Field form={superform} name="email">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Email</Form.Label>
					<Input.Root {...props} type="email" bind:value={$formData.email} />
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
		<Button.Root type="submit">Continue</Button.Root>
	</Card.Content>
</Card.Root>
```

### Named export (single-component primitives)

Some primitives have no compound surface (Badge, Skeleton):

```svelte
<script lang="ts">
	import { Badge } from '@repo/ui/primitives/badge';
</script>

<Badge variant="success">Active</Badge>
```

Check the primitive's `index.ts` if you're unsure which style applies.

## Adding a new primitive

```bash
cd packages/ui
pnpm dlx shadcn-svelte@latest add <name>
```

The CLI emits files into `packages/ui/src/lib/components/primitives/<name>/` with the right Tailwind tokens already wired. Then re-export it from `packages/ui` so apps import via `@repo/ui/primitives/<name>` (the package's exports map already covers `./primitives/*`).

After adding, verify the emitted code uses semantic tokens (no `bg-zinc-…`, no `text-slate-…`).

## Adding a variant to an existing primitive

Edit the primitive's `tv(...)` config directly in `packages/ui/src/lib/components/primitives/<name>/<name>.svelte`. Don't fork.

```svelte
<!-- packages/ui/src/lib/components/primitives/badge/badge.svelte -->
const badgeVariants = tv({
	variants: {
		variant: {
			default: '...',
			success: 'bg-success/15 text-success border-success/30' // added here
		}
	}
});
```

Now `<Badge variant="success">` works everywhere.

## Forbidden raw HTML primitives

| Don't | Do |
|---|---|
| `<button>` | `<Button.Root>` |
| `<input>` (text, checkbox, radio) | `<Input.Root>` / `<RadioGroup.Item>` |
| `<div class="rounded border p-4">` | `<Card.Root>` + `<Card.Content>` |
| `<span class="rounded-full bg-...">` | `<Badge>` |
| Hand-rolled dialog backdrop | `<Dialog.Root>` / `<AlertDialog.Root>` |
| Hand-rolled dropdown | `<DropdownMenu.Root>` |

Exception: native form elements that are wiring, not UI — a hidden `<input type="hidden">` carrying a token, the captcha widget mount `<div>`. These are not "UI primitives", they're structural.

## Icons

Use `@lucide/svelte`, one icon per import path:

```svelte
<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import PlusIcon from '@lucide/svelte/icons/plus';
</script>

<PlusIcon class="size-4" />
<Loader2Icon class="size-4 animate-spin" />
```

Per-icon imports keep the client bundle small. Don't import from `'@lucide/svelte'` root.

## Class merging

Use `cn()` from `@repo/ui/utils` for any conditional class:

```svelte
<script lang="ts">
	import { cn } from '@repo/ui/utils';
</script>

<div class={cn('base', condition && 'extra', className)}></div>
```

## Destructive actions

Any delete / archive / irreversible action MUST be guarded by `<AlertDialog.Root>`. Confirm copy explains what will be removed and that the action cannot be undone.

## File naming

`kebab-case.svelte` always. Never `ModeToggle.svelte`, never `quizCard.svelte`. The formatter does not enforce this — review by eye.
