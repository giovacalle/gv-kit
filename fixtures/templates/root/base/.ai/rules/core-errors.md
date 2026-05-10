# Errors

Two surfaces, never mixed:

| Surface | Pattern | Library |
|---------|---------|---------|
| Server (`+*.server.ts`, `+server.ts`, `hooks.server.ts`, `src/lib/server/**`) | Throw a typed `AppError` | `$lib/server/errors.ts` |
| Client (`+page.svelte`, `src/lib/components/**`, `src/lib/utils/**`) | `Result<T, AppError>` | `neverthrow` via `$lib/utils/result.ts` |

`try/catch` is reserved for the **edge** — wrapping a 3rd-party call that doesn't already throw `AppError`. Never use it for flow control.

## Server — `throwAppError`

`AppError` is an `Error` subclass tagged with a typed `code` (`'NOT_FOUND' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'CONFLICT' | 'INTERNAL_ERROR'`). `throwAppError(code, message)` is the only entry point; `httpStatusFor(code)` maps it to the HTTP status.

```ts
import { throwAppError } from '$lib/server/errors';

const profile = await loadProfile(id);
if (!profile) throwAppError('NOT_FOUND', 'Profile not found');

if (profile.ownerId !== locals.session?.user.id)
  throwAppError('FORBIDDEN', "You don't have permission to view this");
```

Single-statement `if` body → omit braces, single line (see `core-style.md`).

## Route boundary — `guardAppError`

`+server.ts` handlers and load functions that may throw `AppError` wrap their body in `guardAppError`, which converts to SvelteKit's `error(status, body)` so the response shape matches `App.Error` and `src/routes/+error.svelte` can read `page.error.code`.

```ts
export const GET: RequestHandler = async (event) =>
  guardAppError(async () => {
    const profile = await loadProfile(event.params.id);
    if (!profile) throwAppError('NOT_FOUND', 'Profile not found');
    return json(profile);
  });
```

## Form actions — inline failures, NOT throws

Form actions surface validation / business failures through `sveltekit-superforms` envelopes, not throws. Only `redirect()` escapes.

- Invalid form → `fail(400, { form })` after `!form.valid`.
- Field-specific error → `setError(form, 'fieldName', msg, { status })`.
- Form-level error → `message(form, payload, { status })`.
- `AppError` thrown from a helper inside an action → catch locally, convert to one of the above.

```ts
try {
  await doTheThing(form.data);
} catch (e) {
  if (isAppError(e)) return message(form, e.message, { status: httpStatusFor(e.code) });
  throw e;
}
```

## Client — `Result<T, AppError>`

Anything that may fail in the browser returns a `Result`. `$lib/utils/result.ts` re-exports `ok`, `err`, and a `fromPromise` that maps unknown errors to `AppError('INTERNAL_ERROR', ...)`.

```ts
const r = await fromPromise(authFetch('/api/me').then((res) => res.json()));
if (r.isErr()) {
  if (r.error.code === 'UNAUTHENTICATED') return goto('/login');
  toast.error(r.error.message);
  return;
}
user = r.value;
```

## When `try/catch` IS allowed

Only at the edge — wrapping a library that doesn't return `Result` and doesn't throw `AppError`. `fromPromise` already does this for promise-returning APIs; reach for it before hand-rolling a `try/catch`.

## Anti-patterns

| Don't | Do |
|-------|-----|
| `throw new Error('not found')` | `throwAppError('NOT_FOUND', 'X not found')` |
| `try/catch` for branching | `fromPromise(...)` |
| Throw `AppError` from a form action | `setError` / `message` |
| Rebrace single-statement `if` | One-liner: `if (!x) throwAppError(...)` |
