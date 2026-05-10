# Tailwind v4 + shadcn-svelte

Tailwind 4, no JS config, semantic tokens only, primitives shared via `@repo/ui`.

## No `tailwind.config.js`

Tailwind v4 reads its config from CSS via `@theme`. There is NO `tailwind.config.js` in this project. If you find yourself wanting one, you're solving the wrong problem.

The build pipeline:

1. `apps/web/vite.config.ts` registers `@tailwindcss/vite`.
2. `apps/web/src/app.css` is the entry point. It contains `@import "@repo/ui/styles"` and nothing else of substance.
3. `packages/ui/src/lib/styles/app.css` declares all `@theme` tokens (colors, radii, fonts, spacing scale tweaks). This is the single source of truth across the workspace.

```css
/* apps/web/src/app.css */
@import '@repo/ui/styles';
```

That's it. App-specific `@layer utilities` extras go below the import, but design tokens stay in `packages/ui`.

## Semantic tokens — never hardcode colors

Every color reference uses a semantic token. Never write `bg-blue-500`, `text-gray-700`, `border-zinc-200`, etc.

| Use case | Token |
|---|---|
| Page background | `bg-background` |
| Card background | `bg-card` + `text-card-foreground` |
| Popover / dialog background | `bg-popover` + `text-popover-foreground` |
| Muted background | `bg-muted` |
| Muted accent tint | `bg-accent` + `text-accent-foreground` |
| Primary action | `bg-primary` + `text-primary-foreground` |
| Secondary action | `bg-secondary` + `text-secondary-foreground` |
| Main text | `text-foreground` |
| Muted text | `text-muted-foreground` |
| Borders | `border-border` |
| Input borders / fills | `border-input` / `bg-input` |
| Focus rings | `ring-ring` |
| Destructive | `text-destructive` (use `bg-destructive/10` + `hover:bg-destructive/20` for buttons) |

```svelte
<!-- BAD -->
<div class="bg-blue-500 text-white">

<!-- GOOD -->
<div class="bg-primary text-primary-foreground">
```

## Adding a new token

If a new design need lands (a `success` color, a `warning` band), add the variable in `packages/ui/src/lib/styles/app.css` under `@theme` for both the light root and the `.dark` block. Do NOT define ad-hoc CSS variables in `apps/web`.

```css
/* packages/ui/src/lib/styles/app.css */
@theme {
	--color-success: oklch(0.66 0.17 145);
	--color-success-foreground: oklch(0.99 0 0);
}

.dark {
	--color-success: oklch(0.7 0.16 145);
	--color-success-foreground: oklch(0.16 0 0);
}
```

After adding, the utility `bg-success` / `text-success` is available everywhere with no further config.

## Customizing primitive variants

Every shadcn-svelte primitive uses `tailwind-variants` (`tv(...)`) for its variant config. To add a variant or tweak an existing one, edit the primitive's `tv(...)` config IN PLACE in `packages/ui/src/lib/components/primitives/<name>/<name>.svelte`. Never fork the primitive into the app.

```svelte
<!-- packages/ui/src/lib/components/primitives/badge/badge.svelte -->
<script lang="ts">
	import { tv } from 'tailwind-variants';

	const badgeVariants = tv({
		base: 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground border-transparent',
				success: 'bg-success/15 text-success border-success/30', // added locally
				destructive: 'bg-destructive/15 text-destructive border-destructive/30'
			}
		}
	});
</script>
```

The new `variant="success"` is now usable everywhere `Badge` is consumed.

## Anti-patterns

| Don't | Do |
|---|---|
| Add `apps/web/tailwind.config.js` | Tokens in `packages/ui/src/lib/styles/app.css` `@theme` block |
| `class="bg-violet-500"` | `class="bg-primary"` |
| Inline custom CSS variables in a component | Add to `@theme` in `packages/ui` |
| Fork a primitive to add a `success` variant | Edit `tv(...)` in `packages/ui/src/lib/components/primitives/<name>/` |
| Import Tailwind in two places | Single `@import "@repo/ui/styles"` in `apps/web/src/app.css` |
