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

### Authorizing Cloudflare previews

Preview credentials must leave repository and shared organization secret scopes before activation. Store only `PREVIEW_POLICY_TOKEN` there, a repository-scoped fine-grained token with read-only Administration, Environments, Secrets, and Metadata permissions. Writers can read this token, so it must grant metadata access only, never provider access or write permissions. Keep production credentials in the separately protected existing `production` environment. Remove accessible copies from other environments and rotate formerly exposed values. No secret migration or remote activation is automatic.

Create an empty `cloudflare-preview` environment with selected deployment branches and exactly one literal default-branch rule of type `branch`. No tags, wildcards, PR refs, or "protected branches only" mode. Enforce classic default-branch protection for administrators, disable force pushes/deletion, and restrict push/merge access to explicit built-in maintain/admin users. Teams, apps, and rulesets-only configurations are not supported by this verifier. Organization repositories and an appropriate GitHub plan are required. Administrators who can change these protections remain trusted operators. Audit the default-branch workflow history and cancel old queued runs before activation.

From audited source, supply `PREVIEW_POLICY_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_ID`, and `GITHUB_REF=refs/heads/<default-branch>` privately. Run `node scripts/verify-cloudflare-preview-policy.mjs --check-protection` before installing any preview secret. Then install exactly the `PREVIEW_*` environment secrets listed in the generated README using your approved secret tool and run the script with `--verify`. These are preview-only values, not renamed production values. Authorization and each privileged recheck verify the live policy and complete secret-name inventories. Missing, unsafe, incomplete, or unavailable checks deny work. The workflow token alone is not assumed to have these metadata permissions.

GitHub's environment/ref restriction withholds preview credentials from writer-controlled branch dispatches and same-repository PR workflows even when their workflow code omits authorization. A workflow-side check cannot protect credentials that an operator has already installed in an unsafe scope. Do not install them until the prerequisite audit passes, and rerun the audit after access/protection changes. No second approver is required; self-authorization remains allowed.

Cleanup uses the same environment and audits prerequisites before alias validation. Closed-PR cleanup still runs from trusted default-branch code and keeps inventory/namespace checks; it does not require an open PR or a still-authorized deployment actor. Uploaded inventories remain eligible after a deployment fails or is cancelled, provided the completed run and manifest pass provenance and identity checks. After trusted setup and alias validation, namespace-scoped cleanup still runs if inventory collection fails. Failed or partial collections cannot authorize legacy database deletion, and missing inventories or deletion failures leave the final cleanup report unsuccessful.

Normal unprivileged PR CI stays automatic. Privileged Hono previews use default-branch `workflow_dispatch` with required `pr_number` and full 40-character `head_sha` inputs. Review that exact head before dispatching, including same-repository PRs. The gate checks the live repository, open PR, head repository, current head, run identity, default-branch workflow ref and pinned workflow SHA.

Only the built-in repository `maintain` and `admin` roles qualify. GitHub maps `maintain` to legacy `permission: write`, so the gate also checks `role_name`. Write, custom roles, bots, missing identities, and API failures are denied. A maintainer may authorize their own PR. Reruns require the same original and triggering actor login and ID, original inputs, and pinned workflow revision. Every privileged phase rechecks current permission and head; revocation or a new commit requires a new authorization. Already completed provider operations cannot be undone by a later failed recheck.

Authorization allows application code to read its preview runtime bindings and database data. Passive publication and exact configuration validation protect deployment tooling and destinations; they do not make arbitrary application code trustworthy. Configure only operator-safe preview secrets, sandboxed integrations, and sanitized data, never production credentials. A cloned Neon branch does not prove its contents are sanitized. Preview auth secrets and connection strings are delivered through private temporary secret files and runtime bindings, never Wrangler variables or build artifacts.

The `authorize` job's versioned `revision` JSON output pins repository and head repository IDs/names, PR number, head SHA, trusted SHA/ref, actor ID/name, run ID, and canonical alias. Rechecks compare this contract and deployment inventories retain it. The trusted migration runner now fetches migration data directly from that immutable head using GitHub's Git objects API. It verifies blob hashes and rejects truncated trees, path escapes, symlinks, executable files, missing SQL, and malformed metadata before invoking a provider. It never uses post-build workspace bytes or falls back to base migrations.

Commit flat numbered `packages/db/migrations/*.sql` files generated by Drizzle Kit 0.31 before dispatch. Neon requires a complete matching `meta/_journal.json`; JSON snapshots are allowed and validated but are not executable configuration. Input limits are 256 files, 1 MiB per file, and 8 MiB total. D1 name/ID and Neon branch/project/endpoint identity are checked against provider metadata for the authorized repository and alias. The Neon preview key needs branch/endpoint read access. Missing or failed checks block publication.

Configuration and exact tool versions come from trusted source. The runner installs Wrangler 4.125.0 or Drizzle Kit 0.31.8 with Drizzle ORM 0.45.0 and postgres 3.4.7 into a fresh private temporary directory, without lifecycle scripts or provider credentials during installation. Only the migration tool receives its required provider credentials. No PR-owned scripts/configuration execute. The runner removes its inputs and tooling on exit. Migration failure blocks Worker publication; a later publication failure does not roll back already applied migrations. Keep migrations compatible with adjacent versions during rollout.

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
