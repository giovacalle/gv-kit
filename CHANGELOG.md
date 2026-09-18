# Changelog

## 1.0.0

### Major Changes

- 9794964: Replace generated direct-service Hono output with one public Hono gateway and private auth and domain services. Existing valid config v2 files generate the gateway automatically without a new choice. The release adds dual ingress, request-scoped SSR transport, versioned domain routes, composed OpenAPI, a flat client, target-specific private deployment rules, and manual migration guidance.

### Minor Changes

- 56b47f2: Make AGENTS.md the single canonical instructions file: it is emitted for every AI-tooling selection and CLAUDE.md is no longer emitted (Claude Code ≥ 2.1.277 reads AGENTS.md natively). The `apps/web` guidance file is renamed `CLAUDE.md` → `AGENTS.md`.

## 0.2.0

### Minor Changes

- 3efa3e0: Add the recommended Astro marketing plus SvelteKit application project shape, preserve legacy integrated projects through strict config migration, and move generated workspaces to Node 24. Add a shardable pairwise scaffold verifier covering every Astro Promise and inside-frontend option interaction.

## 0.1.0

### Minor Changes

- Initial v0 release. Scaffold Turborepo monorepos with SvelteKit + Hono on
  Cloudflare Workers (services container) or `inside-frontend` mode (single
  Worker). Includes generators for `packages/backend`, `packages/db` (Drizzle),
  `packages/i18n` (Paraglide v2), `packages/openapi-client` (Hey API), per-service
  auth/users Hono Workers, deploy artifacts (cf-workers / docker), AI
  tooling (Claude / Codex / Opencode), and a 16-fixture snapshot test suite.
