# Migrate generated Hono projects to the API gateway

The Hono output now has one public API gateway and private auth and domain services. Existing generated repositories need a manual migration. No automatic migration is provided because generated repositories may have changed their routes, deployment files, and service boundaries.

This guide does not split databases, move backend package logic, add a mobile client, or publish an SDK.

## Layout

Move the public gateway to `apps/api/`. Move independently deployable services from the old `apps/api/auth/` and `apps/api/users/` layout to `services/auth/` and `services/users/`.

The gateway must route requests to services through explicit transports. It must not import or mount either service's Hono application. Keep shared horizontal middleware in `packages/backend/`; do not move service-owned domain logic there as part of this migration.

## Routes

Keep one public route contract:

- Better Auth: `/api/auth/*`
- versioned domain API: `/api/v1/*`, including `/api/v1/users/*`
- gateway liveness: `/api/healthz`
- composed OpenAPI: `/api/openapi.json`

Remove direct public service triggers and any unversioned domain routes such as `/api/users/*`. Configure both the web origin's `/api/*` alias and the canonical API origin to reach the same gateway without stripping or rewriting the path.

## Environment

Replace browser-facing service URLs such as `PUBLIC_AUTH_URL`, `PUBLIC_USERS_URL`, and `PUBLIC_API_URL` with the gateway contract:

- `API_PUBLIC_ORIGIN` is the canonical API origin advertised by runtime OpenAPI.
- Browser code uses the web origin's same-origin `/api/*` alias and needs no API base URL.
- `GATEWAY_URL` is the private Node or Docker SSR target.
- `AUTH_URL` and `USERS_URL` are private Node or Docker service targets.
- `BETTER_AUTH_ALLOWED_HOSTS` lists explicit web, API, preview, and local hosts without schemes.
- `AUTH_CORS_ORIGINS` lists complete browser origins allowed to call the canonical API with credentials.

Keep secret values in the deployment platform's secret manager. Do not copy secrets into environment examples or Wrangler configuration.

## Client imports

Replace service-specific imports such as `@repo/openapi-client/users` with package-root imports from `@repo/openapi-client`. Generate that flat client only from `apps/api/openapi.json`.

Keep Better Auth on its official client. Remove custom auth fetch wrappers and the SvelteKit `/api/auth/*` facade. Browser calls stay same-origin. Server loads and actions pass SvelteKit's request-scoped `fetch` to the flat client.

## Deployment

Deploy in this order:

1. database migrations
2. private services
3. gateway
4. web

Cloudflare private services must have no routes, set `workers_dev` and `preview_urls` to `false`, and receive calls through Service Bindings. Bind web only to `GATEWAY`; bind the gateway to its service targets. Deploy preview resources with one alias and ensure no preview binding or database points to production.

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
3. Confirm browser calls use the web `/api/*` alias and SSR uses the private gateway transport.
4. Confirm private Cloudflare Workers have no public triggers or Docker host ports.
5. Exercise auth cookies, `/api/v1/*`, health, and runtime OpenAPI through both public ingress paths.
6. Inspect preview bindings and deployment order before the first preview deployment.

## Cloudflare references

- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
