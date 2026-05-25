# Style

Micro-conventions that shape how the code reads in this repo. The formatter handles the rest.

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

When you switch to named, define the bag type close to the function — either inline or as a local `type` if reused. Don't pre-create empty container types ahead of need.

## Naming — say what it does, not what it is

Functions, helpers, and variables are named after their **outcome**, not a generic verb or a layer label.

- ✓ `attachUser`, `localize`, `getSessionUser`, `renderClaudeMd`
- ✗ `handleApp`, `doStuff`, `processData`, `manage*`, generic `handle*`

When extracting a helper, the new name should make the call site **shorter to understand**, not just shorter to type. Generic verbs (`handle`, `do`, `process`, `manage`) age into noise — a future reader has to open the function to know what it does. Pick the verb that describes the change to the system: what is now true that wasn't true before?

## Generated code

This rule applies to BOTH the generator code in this repo AND the templates the generators emit.
