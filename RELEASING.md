# Releasing Plectrify (maintainer guide)

Releases are built by GitHub Actions and nowhere else — `pnpm release` refuses
to run outside a runner. To build and test locally, use `pnpm app --dist`
(`--config Release` for a Release build); it runs the same gates and publishes
nothing.

## Steps

**1. Prepare.** Set `VERSION` (`MAJOR.MINOR.PATCH`), commit, and get it onto
`main` with CI green. The GitHub release is the changelog; there is no
CHANGELOG in the repo.

**2. Run the Release workflow** (Actions → Release → Run workflow, on `main`,
with the version from `VERSION`):

- **Windows** builds and tests the installer, tags `vX.Y.Z`, pushes the tag and
  creates the GitHub release — always marked pre-release — with the installer,
  the corresponding-source archive, checksums and the manifest.
- **macOS** and **Linux** then check out that tag, build and test the pkg and
  the .deb, and upload each with its checksum and manifest. Their scripts
  refuse to upload unless the tag names the commit they built.

Notes are the commit bullets since the last tag. Each job also attaches its
artifacts to the workflow run.

**3. Verify.** Install every platform's build from the pre-release and play
through it. Review and correct the notes on GitHub — promotion never touches
them — then check the catalogue the installed builds fetch:

```sh
pnpm --dir packaging verify-live
```

A release can publish perfectly while the CDN serves 404s; the first symptom is
an empty Packages panel on someone else's machine.

**4. Run the Promote workflow** (Actions → Promote, on `main`, same version).
Marks the release **latest** (refused until the macOS and Linux assets are
there), then points plectrify.com at it: `site/src/lib/site.ts` is rewritten,
committed, pushed to `main` and deployed. The deploy needs the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets; without
them, or with *Deploy the site* unticked, the site is left alone. If only the
deploy fails, the promotion still stands — run `pnpm --dir site run deploy`.

## Notes

**Secrets.** Steps 2 and 4 need nothing but the built-in `GITHUB_TOKEN`; only
the site deploy needs Cloudflare's. The catalogue signing key is unrelated to
releases and stays offline (`packaging/README.md`).

**Mac signing.** There is no Apple Developer Program membership, so the mac
build is ad-hoc signed: the pkg is unsigned, not notarized, and without the
hardened runtime. Whoever downloads it must clear the quarantine flag
(`site/src/routes/docs/opening-on-macos/+page.md` is linked from the download
buttons), and every update re-asks for microphone permission. Developer ID
signing (`--developer-id`) would need both certificates imported into a runner
keychain and a notarytool profile named `plectrify` — the workflow does neither
yet.

**Redoing a step.** A pre-release can be rebuilt by re-running the workflow —
the release and tag are deleted first, so hand-edited notes are lost. A single
failed macOS or Linux job can be re-run on its own; it replaces only its own
assets. A promoted version is immutable; correct it by bumping `VERSION`.

**Flags.** `--version` can only agree or abort, never override `VERSION`.
Everything else is forwarded to `scripts/release.<os>.ts` untouched; only
`--developer-id` belongs to the dispatcher. Windows caches the pinned WebView2
and VC++ redistributables in `.release-cache/` and uses the runner's Inno Setup.
