# Style

Micro-conventions that shape how code reads in this repo. They are deliberately small — formatter handles the rest.

## Inline single-line bodies

When the body of a control-flow statement is a single statement, omit the braces and put it on the same line.

- ✓ `if (!row) throw errors.notFound('user not found')`
- ✓ `if (!session) return null`
- ✗ `if (!row) { throw errors.notFound('user not found') }`

Multi-line bodies always use braces. Applies to `if`, `else`, `for`, `while`.

## Function arguments

- 1–2 arguments → positional. `findUserById(db, id)`.
- 3 or more arguments → named via a single object. `createInvoice({ db, userId, amount, currency })`.

The boundary is at 2 because three same-typed `string`s in a row are an accident waiting to happen, and a 3rd argument is the typical point where readability starts to suffer.

When you switch to named, define the bag type close to the function — either inline (`{ db, userId, amount, currency }: { db: Db; userId: string; amount: number; currency: string }`) or as a local `type` if reused. Don't pre-create empty container types ahead of need.

## Naming — say what it does, not what it is

Functions, helpers, and variables are named after their **outcome**, not a generic verb or a layer label. Future you reads the call site, not the definition.

- ✓ `attachUser(event)` — outcome: the user is now on `event.locals`
- ✓ `localize: Handle` — outcome: requests get a resolved locale
- ✓ `getSessionUser(event)` — outcome: returns the user (or null)
- ✗ `handleApp` — what does it handle? Everything?
- ✗ `doStuff`, `processRequest`, `manage*`, `handle*` — placeholder verbs that age into noise
- ✗ `utils.ts` as the home of unrelated helpers — pick a name per concern

When the function is a SvelteKit `Handle`, name it after the side effect it adds to the request (`attachUser`, `localize`, `requireSession`). The `handle` suffix is the type, not the name.

When extracting a helper, the new name should make the call site **shorter to understand**, not just shorter to type. If the call site reads worse after extraction, the abstraction wasn't worth it.

## Comments

Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader.

Don't restate what the code does, don't write reasoning essays, don't leave aspirational TODOs without a real ticket.

## File naming

`kebab-case` for filenames everywhere: `user-card.svelte`, `auth-context.svelte.ts`. Never `UserCard.svelte`. The formatter does not enforce this — review by eye.
