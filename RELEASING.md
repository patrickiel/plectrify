# Releasing Plectrify (maintainer guide)

## Steps

**1. Prepare.** Set `VERSION` (`MAJOR.MINOR.PATCH`) and commit everything —
every script refuses a dirty tree. The GitHub release is the changelog; there is
no CHANGELOG in the repo.

**2. Windows — build and test.**

```sh
pnpm release:build
```

Builds, tests and packages the installer into `artifacts/<version>-<commit>/`,
publishing nothing. Install it and play through it: nothing after this rebuilds
the app.

**3. Windows — publish the pre-release.**

```sh
pnpm release
```

Builds again, tags `vX.Y.Z`, pushes it, and creates the GitHub release — always
marked pre-release — with the installer, the corresponding-source archive,
checksums and the manifest. Notes are drafted by the local `claude` CLI, falling
back to commit bullets.

**4. Mac — build, test, add the pkg.** At the same commit; the script refuses
otherwise.

```sh
git checkout vX.Y.Z
pnpm release:build   # local pkg, publishes nothing
pnpm release         # uploads the pkg, its checksum and the manifest
```

Re-running replaces the mac assets only, leaving the Windows ones and the notes
alone.

**5. Verify.** Review and correct the notes on GitHub — promotion never touches
them — then check the catalogue the installed builds fetch:

```sh
pnpm --dir packaging verify-live
```

A release can publish perfectly while the CDN serves 404s; the first symptom is
an empty Packages panel on someone else's machine.

**6. Windows — promote.**

```sh
pnpm release:promote
```

Marks the release **latest** (refused until the mac assets are there), then
points plectrify.com at it: `site/src/lib/site.ts` is rewritten, committed,
pushed and deployed. If only the deploy fails, the promotion still stands — run
`pnpm --dir site run deploy`. `--no-site` skips that half.

## Notes

**Mac signing.** There is no Apple Developer Program membership, so the mac
build is ad-hoc signed by default: the pkg is unsigned, not notarized, and
without the hardened runtime. Whoever downloads it must clear the quarantine
flag (`site/src/routes/docs/opening-on-macos/+page.md` is linked from the
download buttons), and every update re-asks for microphone permission. Once
there is a membership, add `--developer-id` to either command, then make it the
default in `scripts/release.ts` and update the README, the getting-started page
and the download buttons.

**Redoing a step.** A pre-release can be rebuilt and republished — the release
and tag are deleted first, so hand-edited notes are lost. A promoted version is
immutable; correct it by bumping `VERSION`.

**Flags.** `--version` can only agree or abort, never override `VERSION`.
`--skip-tests` cannot publish — pair it with `pnpm release:build`. Everything
else is forwarded to `scripts/release.windows.ts` / `scripts/release.macos.ts`
untouched; only `--local` and `--developer-id` belong to the dispatcher.
`ui/package.json` mirrors the three commands for when you are already in `ui/`.

**Prerequisites.** `pnpm install` at the root (`packaging/` and `ui/` install
themselves); `gh auth login` for anything that publishes. Windows bootstraps
Inno Setup, and caches the pinned WebView2 and VC++ redistributables in
`.release-cache/` (`--webview2-installer`, `--vcredist-installer`,
`--inno-setup-installer` for offline builds). `--developer-id` on the Mac also
needs both Developer ID certificates in the login keychain and a notarytool
profile named `plectrify`.
