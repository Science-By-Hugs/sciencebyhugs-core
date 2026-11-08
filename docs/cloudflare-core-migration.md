# Core Cloudflare Pages migration — preparation and cutover checklist

## Decision
- Preserve **Core's existing Supabase owner/admin authentication**. Do **not** enable Cloudflare Access or introduce a new login.
- Keep the live site on GitHub Pages until the owner explicitly approves changing the DNS/custom domain.
- Cloudflare Pages project: `sciencebyhugs-core-prod`
- Temporary Cloudflare URL: https://sciencebyhugs-core-prod.pages.dev
- GitHub repository: `Science-By-Hugs/sciencebyhugs-core`
- Preparation branch: `infra/cloudflare-core-prep-20261108`
- Initial Cloudflare Pages production branch: preparation branch; change to `main` only for final release.
- Node runtime: 22
- Build command: `node scripts/verify-production.mjs && npm run build && node scripts/verify-production.mjs --dist`
- Build output: `dist`; base path: `/`.
- Keep `sbh-core-v2-staging` untouched. It is a distinct environment.

## Assets and session behavior
- PWA icons are checked in from the existing approved `public/brand/core-app-icon.svg`, rather than generated only inside GitHub Actions.
- Do not change the PWA `id`, `start_url`, `scope`, or `core.sciencebyhugs.com` domain during cutover.
- Core's login, permissions, data, and API calls continue to use the existing Supabase project.
- The `pages.dev` preview is connected to the **live Supabase backend**. During review, use read-only pages and do not submit test payments, orders, inventory adjustments, expenses, or notification actions unless separately approved.
- `public/_headers` sets anti-indexing and safe PWA cache refresh headers; it does not add authentication or Cloudflare Access.

## Required pre-cutover checks
1. Cloudflare GitHub integration automatically builds changes pushed to the preparation branch.
2. Cloudflare build passes TypeScript and Core's prebuild/postbuild production checks.
3. Check `/`, `/manifest.webmanifest`, `/sw.js`, `/push-sw.js`, three PNG icons and the Apple touch icon over HTTPS.
4. Test owner login and sign-out on the temporary address without performing mutating operations.
5. Confirm Core dashboard, orders, inventory, customers, financial reporting and export pages render.
6. Check the installed iPhone PWA, service-worker updates, icons and push notification registration carefully. A preview domain has a different browser origin: existing push subscriptions and login sessions **do not transfer** across origins.
7. Confirm GitHub's planned private-repository visibility still permits Cloudflare's GitHub App to read and build the repository.
8. Require passing Core CI, a rollback plan, and explicit owner sign-off.

## Final cutover (NOT authorized in preparation)
1. Merge tested preparation changes into `main` using a PR.
2. Set the Cloudflare Pages production branch to `main`; verify the `main` build.
3. Add `core.sciencebyhugs.com` as a Cloudflare Pages custom domain and complete DNS validation. Existing DNS currently points to `sciencebyhugs.github.io`. Only then replace the record.
4. Verify production HTTPS, login, financial reads, PWA updates, QR routes and notifications.
5. Make GitHub repository private and verify Cloudflare continues to build from it.
6. Stop the legacy GitHub Pages deployment workflow **only after** Cloudflare is verified.
7. Preserve the legacy GitHub Pages artifact/configuration temporarily for rollback.

## Rollback
- If Cloudflare custom-domain hosting fails, restore the prior `core.sciencebyhugs.com` DNS target `sciencebyhugs.github.io`, if the legacy GitHub Pages site remains configured.
- Cloudflare Pages deployment rollback restores static application files only, not Supabase data.
- Do not delete the original Pages project or disable GitHub Pages before operational sign-off.
