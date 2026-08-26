# Service Architecture

`apps/api/` is the public Hono API gateway. Independently deployable private Workers live under `services/<service>/`, for example `services/auth/` and `services/users/`.

## Rules

- **The gateway owns public API ingress.** The web origin's `/api/*` alias and canonical API origin reach the same gateway. Better Auth stays under `/api/auth/*`; domain routes use `/api/v1/*`; `/api/healthz` and `/api/openapi.json` are operational endpoints. Private services have no browser-facing route.
- **Auth is a private service.** It is served exclusively by `services/auth/`; no other service exposes auth endpoints or reads auth secrets.
- **Private calls use explicit transports.** The gateway binds to private services. The Cloudflare web Worker binds only to `GATEWAY`. A service such as users may bind directly to `AUTH` for `/internal/session`. Internal calls never route back through the gateway.
- **Session transport uses the existing middleware.** `@repo/backend/middleware/auth` selects the direct `AUTH` Service Binding on Cloudflare or the private `AUTH_URL` on Node and Docker. Do not generate a duplicate local auth client.
- **The public contract is composed.** Services own deterministic OpenAPI fragments; `apps/api/openapi.json` is the sole Hey API input, and `packages/openapi-client` exposes one flat client.
- **No cross-service domain state in `packages/backend`.** That package contains horizontal helpers and middleware only. Auth state, billing state, and RBAC remain with their owning services.
- **Bindings are explicit per deployable.** Each Worker owns its `wrangler.jsonc`; Wrangler generates Cloudflare `Env` declarations. There is no shared environment blob.
- **The gateway never imports a service app.** It forwards through the explicit prefix-to-target map.
- **Private deployment stays private.** Cloudflare services have no routes, workers.dev hostname, or production preview URL. Docker services have no host ports. Local service ports bind to loopback for debugging.
- **Credentialed CORS uses an explicit allowlist.** Wildcard credentialed CORS is forbidden.

## Why

- Public consumers depend on one stable gateway contract rather than private deployment topology.
- Services remain private and independently deployable.
- Direct private bindings avoid public network hops without treating reachability as authorization.
