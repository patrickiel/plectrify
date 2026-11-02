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
there). That is all it does, and all it needs to: the download buttons on
plectrify.com and in the README link to
`/releases/latest/download/Plectrify-<platform>.<ext>`, so they serve the new
version the moment the flag moves, with no commit and no site deploy. The asset
names carry no version for exactly that reason — keep it that way, or those
links break on the next release. Until a version is promoted the buttons keep
serving the previous one, since GitHub's "latest" skips pre-releases.

## Notes

**Secrets.** Step 4 needs nothing but the built-in `GITHUB_TOKEN`; step 2's
Linux job also needs `APT_SIGNING_KEY` (below), and waits for a reviewer to
approve it. The catalogue signing key is unrelated to releases and stays
offline (`packaging/README.md`).

**Linux update channel.** The .deb installs an APT source pointing at
`/releases/latest/download/`, and the Linux job publishes a signed flat
repository there (`Packages`, `Release`, `InRelease`) beside the .deb — see
`scripts/aptRepository.ts`. So, like the download buttons, installed copies
upgrade when a release is promoted, and promotion refuses a release missing
those files. The public key is committed at
`Assets/linux/plectrify-archive-keyring.asc` and ships in every .deb; the
private key is the `APT_SIGNING_KEY` secret of the `apt-signing` environment,
which only the Linux job names. The script refuses a secret whose fingerprint
is not the committed key's. One-time setup, on a trusted machine:

```sh
export GNUPGHOME="$(mktemp -d)"
gpg --batch --passphrase '' --quick-gen-key \
  'Plectrify Releases <hello@plectrify.com>' ed25519 sign never
gpg --armor --export > Assets/linux/plectrify-archive-keyring.asc
gpg --armor --export-secret-keys | gh secret set APT_SIGNING_KEY --env apt-signing
gpg --armor --gen-revoke "$(gpg --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')" \
  > plectrify-apt-revoke.asc   # store offline with a key backup, then:
rm -rf "$GNUPGHOME"
```

The key in use (fingerprint `0AB4F0B83B78B13695FB8BA8BA3F4B1D8C03FF84`) was
made this way; its backup and revocation certificate are kept offline beside
the catalogue key, as `~/.plectrify/apt-signing.key` and
`apt-signing-revoke.asc`.

Create the environment first (Settings → Environments → `apt-signing`, add
yourself as a required reviewer). The key never expires on purpose: every
installed copy trusts this one key, so replacing it means shipping a .deb that
carries the new key while the old one still signs, and only then switching.
Never sign with a different key without that overlap — installs would stop
updating with nothing on screen to say why.

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
