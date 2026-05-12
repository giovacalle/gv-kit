# @repo/ui

Shared UI package for this monorepo.

## Layout

- `src/lib/styles/app.css` — design tokens (light + dark) and Tailwind v4 setup. Single source of truth for the palette.
- `src/lib/components/primitives/<name>/` — shadcn-svelte primitives.
- `src/lib/components/<name>/` — generic composites (mode toggle, theme watcher).
- `src/lib/utils.ts` — `cn()` and `tv()` helpers.

## Usage

```ts
import * as Button from '@repo/ui/primitives/button'
import ModeToggle from '@repo/ui/components/mode-toggle/mode-toggle.svelte'
import { cn } from '@repo/ui/utils'
```

In an app's root CSS:

```css
@import 'tailwindcss';
@import '@repo/ui/styles';
```

## Adding primitives

```sh
pnpm dlx shadcn-svelte@latest add <name>
```

The CLI writes into `src/lib/components/primitives/<name>/`. Commit the output.

## Editing tokens

Edit OKLCH variables under `:root` and `.dark` in `src/lib/styles/app.css`. Apps re-import this file — no per-app theme drift.
