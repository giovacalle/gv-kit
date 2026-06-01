# Changelog

## 0.1.0

### Minor Changes

- Initial v0 release. Scaffold Turborepo monorepos with SvelteKit + Hono on
  Cloudflare Workers (services container) or `inside-frontend` mode (single
  Worker). Includes generators for `packages/backend`, `packages/db` (Drizzle),
  `packages/i18n` (Paraglide v2), `packages/openapi-client` (Hey API), per-service
  auth/users Hono Workers, deploy artifacts (cf-workers / docker), AI
  tooling (Claude / Codex / Opencode), and a 16-fixture snapshot test suite.
