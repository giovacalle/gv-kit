# Service Architecture

`apps/api` is a CONTAINER of services. Each subdirectory under `apps/api/` is its own deployable Hono worker, e.g. `apps/api/auth/`, `apps/api/billing/`.

## Rules

- **Auth is a service.** Served exclusively by `apps/api/auth/`. No other service exposes auth endpoints.
- **Inter-service calls = inline `fetch`.** Each consumer keeps a local ~10 LOC client that wraps `fetch(env.AUTH_BASE_URL + ...)`. Do NOT extract a shared SDK package.
- **No cross-service infra in `packages/backend`.** That package is reserved for truly horizontal concerns (logger, error helpers, common middleware). Auth state, billing state, RBAC — these live with their owning service.
- **Bindings are explicit per service.** Each service declares its own `wrangler.jsonc` with its own bindings (D1, KV, R2, secrets). No shared `env` blob.

## Why

- Services stay independently deployable.
- Cross-cutting concerns surface as deliberate code, not hidden imports.
- Easier to rip out or replace a single service.
