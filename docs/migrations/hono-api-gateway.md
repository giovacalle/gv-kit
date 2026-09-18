# Migrate generated Hono projects to the API gateway

The Hono output now has one public API gateway and private auth and domain services. Existing generated repositories need a manual migration. No automatic migration is provided because generated repositories may have changed their routes, deployment files, and service boundaries.

This guide does not split databases, move backend package logic, add a mobile client, or publish an SDK.

## Layout

Move the public gateway to `apps/api/`. Move independently deployable services from the old `apps/api/auth/` and `apps/api/users/` layout to `services/auth/` and `services/users/`.

The gateway must route requests to services through explicit transports. It must not import or mount either service's Hono application, import application use cases, or orchestrate business workflows. Keep reusable data access, use cases, types, helpers, and middleware in the shared `packages/backend/` application/core layer. Deployable services are transport/runtime adapters and may import the application modules they need from that package.

## Routes

Keep one public route contract:

- Better Auth: `/api/auth/*`
- versioned domain API: `/api/v1/*`, including `/api/v1/users/*`
- gateway liveness: `/api/healthz`
- composed OpenAPI: `/api/openapi.json`

Remove direct public service triggers and any unversioned domain routes such as `/api/users/*`. Configure both the web origin's `/api/*` alias and the canonical API origin to reach the same gateway without stripping or rewriting the path.

## Environment

Remove browser-facing service URLs such as `PUBLIC_AUTH_URL`, `PUBLIC_USERS_URL`, and `PUBLIC_API_URL`. Browser code uses the web origin's same-origin `/api/*` alias and needs no API base URL.

Use this topology environment inventory. Retain separate database, OAuth, email, and other feature-specific variables already required by the generated project.

| Variable | Owner / consumer | Value class and target scope |
| --- | --- | --- |
| `API_PUBLIC_ORIGIN` | Gateway (`apps/api`) | Public, non-secret canonical API origin advertised by runtime OpenAPI. Required for Cloudflare, Docker, and Node; use the origin for the current local, production, or preview environment. |
| `GATEWAY_PUBLIC_ORIGINS` | Gateway (`apps/api`) | Public, non-secret comma-separated allowlist of complete web and API origins accepted at ingress. Required by generated startup for every target. |
| `API_CORS_ORIGINS` | Gateway (`apps/api`) | Public, non-secret comma-separated browser-origin allowlist for credentialed CORS across the canonical public API. Required by generated startup for every target. |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | Gateway (`apps/api`) | Non-secret private-service timeout in milliseconds. Required by generated startup; generated deployment output uses `10000`. |
| `GATEWAY_TRUSTED_INGRESS_SECRET` | Gateway plus trusted web SSR and ingress callers | Secret shared only across the Node or Docker private ingress boundary. It authenticates forwarded public host and scheme metadata; it is not a public origin, URL, or Cloudflare binding. |
| `GATEWAY_URL` | Web SSR (`apps/web`) | Private Node or Docker gateway target. Never expose it to browser code. Cloudflare replaces it with the `GATEWAY` Service Binding. |
| `AUTH_URL` | Gateway and private auth clients | Private Node or Docker auth-service target. Cloudflare replaces it with the `AUTH` Service Binding. |
| `USERS_URL` | Gateway (`apps/api`) | Private Node or Docker users-service target. Cloudflare replaces it with the `USERS` Service Binding. |
| `BETTER_AUTH_ALLOWED_HOSTS` | Auth service (`services/auth`) | Non-secret comma-separated request-host allowlist. Entries omit schemes and must cover only the current web, API, local, or preview hosts. |
| `AUTH_CORS_ORIGINS` | Auth service (`services/auth`) | Non-secret comma-separated browser-origin allowlist for the auth service's own CORS contract. It does not configure canonical API CORS at the gateway. |

`API_CORS_ORIGINS` is the canonical API CORS control. `AUTH_CORS_ORIGINS` remains a service-owned defense for auth routes; keep it scoped to origins allowed to use auth, but do not substitute it for the gateway allowlist. Wildcards are invalid for credentialed requests.

Complete origins include `http://` or `https://` and contain no path. Host allowlist entries omit the scheme. Private target URLs name loopback or internal network endpoints, never public browser endpoints. Local examples are not production defaults, and production values must not be copied into previews.

### Local and Node startup

Copy `.env.example` to `.env` and use the generated root commands. The local startup script validates `API_PUBLIC_ORIGIN`, `GATEWAY_PUBLIC_ORIGINS`, `API_CORS_ORIGINS`, `GATEWAY_UPSTREAM_TIMEOUT_MS`, `GATEWAY_URL`, `AUTH_URL`, and `USERS_URL`. Non-Cloudflare Node output also requires `GATEWAY_TRUSTED_INGRESS_SECRET`; selected auth and infrastructure features add their own requirements.

The Node gateway entrypoint hard-requires `API_PUBLIC_ORIGIN` and `GATEWAY_TRUSTED_INGRESS_SECRET`. Node gateway startup fails if either is absent. Set the remaining gateway values explicitly rather than relying on runtime fallbacks, and use loopback private targets only for local development. The same secret must be available to Node web SSR so its trusted forwarded metadata can be verified. Cloudflare local development uses Service Bindings and does not require this secret.

### Cloudflare production and previews

Place `API_PUBLIC_ORIGIN`, `GATEWAY_PUBLIC_ORIGINS`, `API_CORS_ORIGINS`, and `GATEWAY_UPSTREAM_TIMEOUT_MS` in `apps/api/wrangler.jsonc`. Place `BETTER_AUTH_ALLOWED_HOSTS` and `AUTH_CORS_ORIGINS` in `services/auth/wrangler.jsonc`. These are non-secret configuration values. Production uses production hosts only: the canonical API origin, the web and API gateway origins, and the web browser origin allowed by API CORS.

Cloudflare Service Bindings replace `GATEWAY_URL`, `AUTH_URL`, and `USERS_URL`. Cloudflare Service Bindings do not use this secret: omit `GATEWAY_TRUSTED_INGRESS_SECRET` from Wrangler variables and secrets.

The generated preview preparation script derives the PR-scoped API and web origins, rewrites gateway and auth allowlists, preserves the generated timeout, and rewires every Service Binding to the same preview alias. Generated preview allowlists also retain the explicit local development origins. Preview values must name only that preview and must never reference production Workers, hosts, or data bindings.

### Docker startup

Use `.env` as the Compose input. Docker Compose requires the same secret in the gateway, web, and ingress containers and refuses to start if `GATEWAY_TRUSTED_INGRESS_SECRET` is absent. Generate one secret value through an approved secret tool, keep it out of committed files and logs, and rotate it independently for each production or preview environment.

Compose provides private `GATEWAY_URL`, `AUTH_URL`, and `USERS_URL` values from service names; do not replace them with public hosts. Its public-origin and CORS defaults are local conveniences. For production or preview, explicitly set `API_PUBLIC_ORIGIN`, `GATEWAY_PUBLIC_ORIGINS`, `API_CORS_ORIGINS`, and `GATEWAY_UPSTREAM_TIMEOUT_MS` to that environment's values. Configure the ingress host and scheme for the same public API origin.

Keep all secret values in the deployment platform's secret manager. Do not copy secret values into environment examples, Wrangler configuration, migration records, or preview output.

## Client imports

Replace service-specific imports such as `@repo/openapi-client/users` with package-root imports from `@repo/openapi-client`. Generate that flat client only from `apps/api/openapi.json`.

Keep Better Auth on its official client. Remove custom auth fetch wrappers and the SvelteKit `/api/auth/*` facade. Browser calls stay same-origin. Server loads and actions pass SvelteKit's request-scoped `fetch` to the flat client.

## Deployment

Deploy in this order:

1. database migrations
2. private services
3. gateway
4. web

Cloudflare private services must have no routes, set `workers_dev` and `preview_urls` to `false`, and receive calls through Service Bindings. Bind web only to `GATEWAY`; bind the gateway to its service targets.

Cloudflare Hono previews require managed parent domains and an active zone. Set `CLOUDFLARE_PREVIEW_WEB_DOMAIN`, `CLOUDFLARE_PREVIEW_API_DOMAIN`, and `CLOUDFLARE_PREVIEW_ZONE_NAME` as GitHub variables. Provision persistent proxied wildcard DNS records for both parent domains before the first preview. The deployment token needs Zone Read and DNS Read so the staging workflow can verify those shared prerequisites before database or Worker provisioning. The gateway then owns the canonical API route and the more-specific web `/api` and `/api/*` routes. The web Worker owns only the less-specific web route. Cleanup deletes PR-scoped Workers and routes, never shared wildcard DNS. Do not use workers.dev or a SvelteKit proxy as a fallback.

Docker ingress must route both the web `/api/*` alias and canonical API host to the gateway. Do not publish auth or domain service ports. Use private Compose URLs for gateway-to-service, service-to-service, and SSR calls.

For local Node development, start web, gateway, and services from the root command. Treat loopback service ports as debugging endpoints, not application ingress.

## Cookies and CORS

Keep host-only cookies. The web origin and canonical API origin use separate browser cookie jars against the same auth service and session storage. Do not enable cross-subdomain cookies during this migration.

Allow only explicit Better Auth hosts and CORS origins. Never combine credentialed requests with a wildcard CORS origin. Verify `Set-Cookie` passes through the gateway unchanged on both public origins.

## OpenAPI

Each domain service owns a deterministic OpenAPI fragment. Better Auth routes stay outside those fragments. Compose service fragments into `apps/api/openapi.json` and fail composition on path, method, component, or `operationId` collisions.

Keep the checked document free of environment-specific servers. At runtime, `/api/openapi.json` adds exactly one server from `API_PUBLIC_ORIGIN`. Regenerate the flat client after composition and remove every per-service client export.

## Verification

After the manual edits:

1. Run workspace lint, typecheck, tests, and build.
2. Regenerate and check `apps/api/openapi.json`, then regenerate the flat client.
3. Confirm browser calls use the web `/api` and `/api/*` aliases and SSR uses the private gateway transport.
4. Confirm private Cloudflare Workers have no public triggers or Docker host ports.
5. Exercise auth cookies, `/api/v1/*`, health, and runtime OpenAPI through both public ingress paths.
6. Confirm preview wildcard DNS is proxied, managed-domain variables are explicit, gateway routes are more specific than the web route, and cleanup leaves shared DNS intact.

## Cloudflare references

- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
