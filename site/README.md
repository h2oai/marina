# Marina documentation site

The GitHub Pages site combines an Astro landing page, Starlight guides and a generated API explorer.

## Update content

- Edit user guides in `docs/guides/` at the repository root. `bun run sync-docs` copies them into
  the ignored `site/src/content/docs/docs/guides/` collection, preserving guide anchors and mapping
  repository-only references to GitHub. Do not edit or commit the generated copies.
- Add important guide entry points to `site/astro.config.mjs`. The overview lives in
  `site/src/content/docs/docs/overview.md`; the landing page is `site/src/pages/index.astro`.
- Command help and public API declarations drive `docs/reference/`. Run `bun run docs:api` at the
  repository root after changing them; the explorer consumes `docs/reference/api.json`.
- Keep walkthroughs about supported behavior. Internal plans, audits and qualification reports
  do not belong in this public site.

## Preview and validate

Install workspace dependencies with `bun install` at the repository root, then:

```sh
cd site
bun run dev
```

Both development and production builds sync guides automatically. Reproduce the project site's
production prefix before publishing:

```sh
SITE_BASE=/marina SITE_URL=https://h2oai.github.io bun run build
bun run preview
```

Open the preview's `/marina/` path. New landing-page links must use its `href()` helper.
Starlight adds the base to its own root-relative sidebar and favicon URLs; use `/api` and
`/favicon.png` there without prepending `/marina` a second time.

## Publish

`.github/workflows/site-deploy.yml` builds and deploys after relevant changes reach `main`;
it also supports a manual workflow dispatch. Changes under `site/`, `docs/guides/` and
`docs/reference/api.json` trigger it. A successful local build only updates `site/dist/`;
the public site changes after the Pages deployment succeeds.
