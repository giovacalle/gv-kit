# Service Architecture

`packages/backend/` is the shared backend application/core layer for reusable data access, use cases, types, helpers, and middleware. Independently deployable private Workers under `services/<service>/`, for example `services/auth/` and `services/users/`, are transport/runtime adapters. They may import the application modules they need from `@repo/backend`.

## Rules

- **The gateway owns public API ingress.** The web origin's `/api/*` alias and canonical API origin reach the same gateway. Better Auth stays under `/api/auth/*`; domain routes use `/api/v1/*`; `/api/healthz` and `/api/openapi.json` are operational endpoints. Private services have no browser-facing route.
- **The gateway stays thin.** It handles ingress, routing, operational middleware, OpenAPI delivery, and transparent forwarding. It does not import application use cases or orchestrate business workflows.
- **Auth is a private service.** It is served exclusively by `services/auth/`; no other service exposes auth endpoints or reads auth secrets.
- **Private calls use explicit transports.** The gateway binds to private services. The Cloudflare web Worker binds only to `GATEWAY`. A service such as users may bind directly to `AUTH` for `/internal/session`. Internal calls never route back through the gateway.
- **Session transport uses the existing middleware.** `@repo/backend/middleware/auth` selects the direct `AUTH` Service Binding on Cloudflare or the private `AUTH_URL` on Node and Docker. Do not generate a duplicate local auth client.
- **The public contract is composed.** Services own deterministic OpenAPI fragments; `apps/api/openapi.json` is the sole Hey API input, and `packages/openapi-client` exposes one flat client.
- **Application code is reusable across adapters.** Keep reusable data access, use cases, types, helpers, and middleware in `packages/backend/`. Services invoke those modules from their HTTP and runtime boundaries.
- **Bindings are explicit per deployable.** Each Worker owns its `wrangler.jsonc`; Wrangler generates Cloudflare `Env` declarations. There is no shared environment blob.
- **The gateway never imports a service app.** It forwards through the explicit prefix-to-target map.
- **Private deployment stays private.** Cloudflare services have no routes, workers.dev hostname, or production preview URL. Docker services have no host ports. Local service ports bind to loopback for debugging.
- **Credentialed CORS uses an explicit allowlist.** Wildcard credentialed CORS is forbidden.

## Why

- Public consumers depend on one stable gateway contract rather than private deployment topology.
- Services remain private and independently deployable.
- Direct private bindings avoid public network hops without treating reachability as authorization.
