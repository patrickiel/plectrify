# site/ — plectrify.com

The marketing and documentation site. A **fully static** SvelteKit build with no
server, no database and no authentication: `pnpm build` emits a folder of HTML,
CSS, JS and fonts, and an assets-only Cloudflare Worker serves it.

It is an independent package, like `ui/` and `packaging/` — its own
`package.json`, its own install, its own `node_modules`. Nothing in the native
build depends on it and it depends on nothing in the native build.

## Commands

```sh
pnpm install          # once, in this folder
pnpm dev              # http://localhost:5173, hot reload
pnpm build            # → build/  (the folder the Worker serves)
pnpm preview          # serve build/ with Vite
pnpm run cf-preview   # serve the site through the real asset server
pnpm run deploy       # publish to plectrify.com
pnpm check            # svelte-check
pnpm format           # Prettier + Tailwind class sorting
```

These need `pnpm run` in front of them: bare `pnpm deploy` is one of pnpm's own
subcommands and would never reach the script.

`pnpm install` **must** be run from this folder. It carries its own
`pnpm-workspace.yaml` for that reason: pnpm walks up looking for one, and
without it the repo root's is found and the install silently does nothing.

## Deploying

A Cloudflare Worker named `plectrify-site`, configured by `wrangler.jsonc` and
published from this folder:

```sh
pnpm run deploy      # wrangler deploy
```

The Worker has **no `main`** — it is assets-only, so there is no script and
every request is answered by Cloudflare's asset server. `wrangler` uploads
whatever is sitting in `build/`, which is why `wrangler.jsonc` declares
`build.command`: wrangler runs `pnpm build` itself before every
`deploy`/`versions upload`, so neither a stale local `build/` nor a fresh CI
clone with none at all can ship the wrong thing.

There is nothing to configure at runtime because there is no runtime.
`static/_headers` carries the only server-side behaviour — caching and two
security headers — and the asset server reads it verbatim, the same file Pages
read. `not_found_handling` is left at its default so an unmatched URL is a real
404, for the same reason `fallback` is unset in `svelte.config.js`.

`wrangler.jsonc` also declares `plectrify.com` as a custom domain. The zone is
in the same Cloudflare account, so the first deploy created the DNS record and
the certificate; later deploys just re-point it. To check a build against the
real asset server before publishing, `pnpm run cf-preview`.

### www

`www.plectrify.com` 301s to the apex, and **none of it is in this repo**: it is
a proxied `CNAME www → plectrify.com` plus one Cloudflare **redirect rule**,
both configured in the dashboard.

That is deliberate. A redirect is not a deploy — it does not change when the
site does, it needs no build, and a Worker written to do it would be a script
running on every www request forever to produce one header. Cloudflare answers
it at the edge before any Worker is invoked, for free. DNS alone cannot: a name
resolves to an address and knows nothing of paths or status codes, so the CNAME
only makes www _arrive_; the rule is what turns it around.

The cost of keeping it out of the repo is that `git log` will never mention it,
which is why it is written down here. The rule:

| Field  | Value                                                    |
| ------ | -------------------------------------------------------- |
| When   | `http.host eq "www.plectrify.com"`                       |
| Target | `concat("https://plectrify.com", http.request.uri.path)` |
| Status | 301, preserve query string                               |

Deploys are manual on purpose — one command from a machine that already has the
repo, no CI credentials to hold. To automate it later, the same command with a
`CLOUDFLARE_API_TOKEN` in the environment is the whole job.

## Editing content

- **Prose in the docs** — `src/routes/docs/<slug>/+page.md`. Frontmatter gives
  `title` and `description`; the shared prose shell wraps it automatically.
  Adding a page means adding the file **and** an entry in
  `src/lib/docs/nav.ts`, which is the hand-ordered table of contents.
- **Product facts** — `src/lib/site.ts`. Version, download URLs, the demo
  video's YouTube id, and the top navigation all live there rather than being
  scattered through components.
- **A new release** — bump `VERSION` in `src/lib/site.ts` in the same commit
  that publishes the release. The download buttons build their URLs from it.
  It is plain data on purpose: a static site that calls the GitHub API at build
  time is a site whose deploy can fail because of someone else's outage.

## Design

The palette, fonts and control tokens are lifted from `ui/src/app.css` and keep
the same token _names_, so a component can move between the app and the site
without being renamed. The two woff2 files in `static/fonts/` are copies of the
app's — if those are ever changed, copy them again.

The site is **dark only**, unlike the app, which has both themes. It is a
document rather than a window someone lives in for hours, and the product's
signature look is the dark rack against near-black; a light variant would be a
second design to keep honest for no reader who asked for one.

## Naming

The product is **Plectrify**. The codebase, the repository, the built
artefacts and the on-disk folders are still **Plectrify** until the rename lands,
so anything referring to a real file, path or release asset says Plectrify
deliberately — see `ASSET_BASE` in `src/lib/site.ts` and the note in
`docs/packages`. Do not "fix" those to Plectrify ahead of the rename; they would
stop matching what users actually have.
