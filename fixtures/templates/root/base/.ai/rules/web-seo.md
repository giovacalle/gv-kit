# SEO

Every scaffold ships with SEO wired in. The stack: a site config module, a self-contained `<Seo />` component that reads `siteConfig` and `page.url` directly, plus hand-rolled `sitemap.xml` and `robots.txt`.

There is no SEO library dependency. The whole surface is ~120 LOC of hand-rolled code that does exactly what's needed and nothing more.

## The pieces

| File | Role |
|---|---|
| `src/lib/config/site.ts` | Static config: site name, base URL, default OG image, Twitter handles, locale |
| `src/lib/components/seo.svelte` | Self-contained component — reads `siteConfig` + `page.url`, accepts optional `title` / `description` props, and emits the `<svelte:head>` tags |
| `src/routes/sitemap.xml/+server.ts` | Hand-rolled sitemap |
| `src/routes/robots.txt/+server.ts` | Hand-rolled robots.txt |
| `src/routes/<path>/+page.svelte` | Renders its own `<Seo />` — no props for the siteConfig defaults, or `<Seo title={...} description={...} />` to override |

## `siteConfig`

Lives in `src/lib/config/site.ts`. The single source of truth for site-level identity values.

```ts
export const siteConfig = {
	name: 'project-name',
	url: 'https://example.com',
	description: 'One-line site description.',
	defaultOgImage: '/og-image.png',
	twitter: { site: '@example', creator: '@example' },
	locale: 'en_US'
} as const;

export type SiteConfig = typeof siteConfig;
```

Edit this file once at scaffold time. Other config (theme, feature flags) can land in the same folder as it grows; don't extract into the file's name until at least one other config sibling exists.

## `<Seo />` component

Located at `src/lib/components/seo.svelte`. Self-contained: imports `siteConfig` directly, reads `page.url` from `$app/state`, and emits the full `<svelte:head>` baseline. Accepts optional `title` and `description` props that override the siteConfig defaults; everything else (canonical URL, OG image, locale, Twitter handles) is computed.

Tags emitted in `<svelte:head>`:

- `<title>`, `meta name="description"`, `link rel="canonical"`
- OG: `og:title`, `og:description`, `og:type`, `og:url`, `og:image`, `og:site_name`, `og:locale`
- Twitter: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`, `twitter:site`, `twitter:creator`

That's it. No `keywords` (dead since 2009), no JSON-LD slot, no children passthrough.

## Per-page rendering — `<Seo />` in every `+page.svelte`

Every page renders its own `<Seo />`. The layout does NOT render one. With no props, the page picks up siteConfig defaults; pass `title` and/or `description` to override.

```svelte
<!-- src/routes/about/+page.svelte -->
<script lang="ts">
	import Seo from '$lib/components/seo.svelte'
</script>

<Seo title="About" description="Who we are and what we build." />
```

```svelte
<!-- src/routes/+page.svelte — siteConfig defaults are fine, no overrides needed -->
<script lang="ts">
	import Seo from '$lib/components/seo.svelte'
</script>

<Seo />
```

`<svelte:head>` is reserved for non-SEO meta the page actually needs (theme color, lazy-loaded `<script>`, `<link rel="preload">`, etc.). Anything that affects `<title>`, `description`, OG, or Twitter cards goes through `<Seo />`.

### Why pages own `<Seo />` (and the layout doesn't)

An earlier setup rendered `<Seo />` once in `+layout.svelte` with no props, and let individual pages override via a raw `<svelte:head><title>...</title></svelte:head>` block. SvelteKit does not deduplicate `<title>` across `<svelte:head>` instances rendered from different components — the result was **two `<title>` tags in the document**, with browsers picking one in undefined order. Pages now own their `<Seo />` so there's exactly one source of head tags per route.

## Sitemap

Hand-rolled `+server.ts` returning `application/xml`. The route list is a static array — adjust when you add public routes. For dynamic routes (e.g. blog posts, product pages), extend the handler to fetch the list and emit `<url>` entries per item.

```ts
const ROUTES = ['/'] as const;
```

External libraries (`super-sitemap`, etc.) are deliberately avoided — the hand-rolled version is ~20 LOC and has no maintenance dependency.

## robots.txt

```
User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml
```

The `Sitemap:` directive is required for discovery. If the site goes private (staging environment), flip to `User-agent: *\nDisallow: /` in that environment's deploy config rather than committing it.

## JSON-LD

Not shipped by default. When you need structured data (Article, Product, BreadcrumbList, Organization), add a tiny helper component beside `seo.svelte`:

```svelte
<!-- src/lib/components/json-ld.svelte -->
<script lang="ts">
	let { data }: { data: Record<string, unknown> } = $props();
</script>

<svelte:head>
	{@html `<script type="application/ld+json">${JSON.stringify(data)}</script>`}
</svelte:head>
```

Render once per page that needs it. Don't fold it into `<Seo />` — most pages don't need JSON-LD, and forcing the prop on the wrapper bloats the universal load contract.

## Anti-patterns

| Don't | Do |
|---|---|
| `<meta name="keywords" content="...">` | Skip it. Google has ignored the keywords meta since 2009 |
| Pull in `svelte-meta-tags` / `svelte-seo` | The hand-rolled version is ~120 LOC and avoids a dep |
| Put `<Seo />` in `@repo/ui` | App-local. Sharing it forces `@repo/ui` to depend on `$app/state` |
| Read `$app/stores` | Deprecated. Use `$app/state` |
| Render `<Seo />` in `+layout.svelte` AND a `<svelte:head><title>` in pages | Page-level `<Seo />` only — mixing the two produces duplicate `<title>` tags |
| `<svelte:head><title>...</title></svelte:head>` in `+page.svelte` for SEO purposes | Use `<Seo title={...} />`. `<svelte:head>` is for non-SEO tags only (`<script>`, `<link rel="preload">`, theme color, etc.) |
| Forget to render `<Seo />` on a page | Every `+page.svelte` renders one — no props for the siteConfig baseline, props to override |
| Read `siteConfig.url` in every component | Only `<Seo />` and server endpoints (`sitemap.xml`, `robots.txt`) touch it |
| Dynamic sitemap fetched on every request | Cache the route list; or pre-generate at build time when the list is static |
| Forget the `Sitemap:` directive in `robots.txt` | Always emit it; without it, crawlers don't discover the sitemap |
