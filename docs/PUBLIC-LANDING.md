# Noderaft public landing site

Phase 6F.3 implements the public marketing surface as a statically rendered route at `/landing` for internal qualification. The route declares `https://noderaft.ee/` as its canonical URL, but no public domain, proxy, certificate, redirect or production routing is configured in this phase.

## Architecture

- `app/(public)/landing/page.tsx` owns route metadata and forces static rendering.
- `components/landing/landing-page.tsx` is a server component with no API requests, polling, SSE, client state or animation library.
- Shared platform providers (TanStack Query and toast UI) live only in the authenticated/dashboard route groups, so the landing page does not load them.
- Existing Noderaft design tokens, locally hosted IBM Plex fonts and supplied brand assets are reused.
- `app/robots.ts` and `app/sitemap.ts` publish the canonical public origin while keeping authenticated and API paths out of crawler discovery.

## Marketing claim audit

The design mockup is a visual reference, not a source of product truth. Phase 6F.3 therefore removes:

- the unimplemented `curl` installer;
- all prices, trials, free-tier and unlimited-node claims;
- licensing and open-source claims (the repository has no published license file);
- community, email, priority-support and SLA promises;
- unverified SSO, SCIM and commercial mTLS claims;
- exact production fleet or tenant counts;
- language implying a blanket security guarantee.

Published technical statements are limited to behavior represented in the current codebase: rootless-compatible agent operation, server-side authorization, tenant-scoped access, explicit agent operations, managed Compose revisions/releases/rollback, hashed session-token storage, httpOnly session cookies, encrypted managed secrets and audit context for privileged actions.

## Demo-data boundary

The product preview is HTML/CSS rendered with intentionally fictional names (`Harbor API`, `Beacon Worker`, `demo-edge`) and is labelled `demo data`. It contains no screenshot or value sourced from a live Noderaft installation.

## Qualification

Run against an already-started local build:

```bash
NODERAFT_LANDING_URL=http://127.0.0.1:3103/landing npm run test:landing
```

The qualifier covers desktop, laptop, tablet and mobile viewports; metadata and CTA targets; mobile/desktop navigation; horizontal overflow; console errors; failed requests; screenshots; and production JavaScript transfer reporting.
