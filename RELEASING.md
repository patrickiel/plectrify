# Releasing Plectrify (maintainer guide)

Releases are built locally on two machines; GitHub Actions are not required.
The version lives in the `VERSION` file, and **the GitHub release is the
changelog** — there is no CHANGELOG in the repository.

The whole flow is `pnpm release`, the same command on both machines, plus
`pnpm release:promote` at the end. Nothing takes a parameter.

| | Windows | macOS |
|---|---|---|
| Build and test locally | `pnpm release:windows` | `pnpm release --no-upload` |
| Add to the release | `pnpm release` | `pnpm release` |
| Publish | `pnpm release:promote` | |

## The workflow

### 1. Prepare

Set the version in `VERSION` (plain `MAJOR.MINOR.PATCH`) and commit
everything. Every script refuses a dirty working tree, so what ships always
matches a commit.

### 2. Build and test on Windows

```sh
pnpm release:windows
```

Builds the UI and native Release target, runs the UI and native test suites,
and compiles the x64 Inno Setup installer into a commit-specific directory such
as `artifacts/0.1.0-e2fd51a32331/`. It publishes nothing.

Install that installer and play through it before going further. Nothing after
this point rebuilds the app, so this is where a bad build is cheapest to catch.

### 3. Publish the pre-release from Windows

```sh
pnpm release
```

Builds again, then creates the annotated tag `vX.Y.Z`, pushes it, re-reads it
back from `origin` to confirm it landed on the release commit, and creates a
GitHub release **always marked pre-release**, carrying the installer, the AGPL
corresponding-source archive, checksums, build info and the release manifest.

Release notes are written by Claude (via the local `claude` CLI) from the commit
subjects since the previous tag, following `packaging/release-notes-prompt.md`.
If the CLI is missing or fails, the script warns and falls back to raw commit
bullets so the release still ships.

### 4. Build, test and add the Mac artifact

To build and play through the app on the Mac, use the dev loop — it signs
nothing and needs no Apple account:

```sh
pnpm install                        # once — root tooling (tsx)
pnpm app --dist --config Release
```

Then produce the release artifact, at the same commit — the script refuses to
run if the remote tag doesn't name its checkout:

```sh
git checkout vX.Y.Z
pnpm release
```

This builds, signs with the hardened runtime and `cmake/Plectrify.entitlements`,
packages a DMG, notarizes it, staples, checks it with `spctl`, and uploads the
DMG, its checksum and `release-manifest-macos.json` onto the existing `vX.Y.Z`
release. Re-running replaces the mac assets without touching the Windows ones or
the notes.

Unlike the Windows side, there is no unsigned local half of this script:
`codesign` runs unconditionally, so **every** path through `scripts/release.macos.ts`
signs something — `--no-upload` and `--no-notarize` skip the upload and the
notarization round-trip, not the signing. What differs is *what* it signs with,
and that is the one decision this script cannot make for you.

#### Releasing without an Apple Developer Program membership

```sh
pnpm release --ad-hoc
```

Developer ID signing and notarization both require a paid membership (99 USD a
year); there is no free tier and no open-source exemption. `--ad-hoc` signs with
the ad-hoc identity, skips notarization and the `spctl` assessment, and is
allowed to upload anyway — the one publishable mode that needs no Apple account.
It also drops the hardened runtime, deliberately: the runtime is a *requirement
of* notarization rather than a benefit on its own, and leaving it on would
enforce library validation against third-party VST3s signed by other people,
which is the exact thing `disable-library-validation` exists to undo.

The cost falls on whoever downloads it. A browser marks the DMG quarantined,
and macOS refuses a quarantined ad-hoc app with the words *"Plectrify is damaged
and can't be opened"* — so `site/src/routes/docs/opening-on-macos/+page.md`
exists to be linked from the release notes, and the download buttons point at it
on every OS but Windows. Channels that set no quarantine flag (a Homebrew tap,
`curl`, `git`) are unaffected. One further consequence: TCC keys microphone
permission to an ad-hoc app's exact build, so **every update asks for the
microphone again**.

`release-manifest-macos.json` records which mode produced the artifact —
`signature: "ad-hoc" | "developer-id"` and `notarized: true | false`, two fields
rather than the one `signed` boolean that could not describe this.

Switching back is one flag: drop `--ad-hoc` once the certificate is in the
keychain, and update the README, the getting-started page and the download
buttons, which currently tell people the build is not notarized. Without the
flag the script now checks the keychain up front and names `--ad-hoc` in the
error rather than failing at the first `codesign` twenty minutes into a build.

`pnpm release --no-upload` is still worth a run before the real one if you want
to exercise signing and notarization without publishing — but it is a test of
the process, not a dry run of the artifact: signing timestamps make every build
unique, so the real run produces a different DMG and a rehearsal must never be
uploaded by hand.

### 5. Verify the release as a whole

Review the generated notes on GitHub and correct anything Claude got wrong;
promotion never touches them. Then check the catalogue the installed builds
will actually fetch:

```sh
pnpm --dir packaging verify-live
```

Nothing in either release script asserts this, and the failure is silent from
the build's point of view: a release packages and publishes perfectly while the
CDN serves 404 for every object, and the first symptom is an empty Packages
panel on someone else's machine. 0.1.0 shipped its pre-release in exactly that
state. Opening the Packages panel in the installed build tests the same thing
from the other end.

### 6. Promote, from Windows

```sh
pnpm release:promote
```

Clears the pre-release flag and marks the release **latest**, which is what the
in-app update check reads. It does not rebuild and does not touch the notes, and
it refuses until the release carries the macOS DMG, its checksum and its
manifest — so "latest" never means Windows only.

It then points plectrify.com at the new version and deploys it: `VERSION` in
`site/src/lib/site.ts` is rewritten, committed and pushed, and the site is
built and published. That happens **after** the release is latest and never
before — the download buttons deep-link to `releases/download/vX.Y.Z/…`, which
serves a pre-release's assets perfectly happily, so deploying first would offer
an untested build for as long as the promote took.

If the deploy fails, the promotion still stands and nothing needs redoing —
fix the cause and run `pnpm --dir site run deploy`. Use `--no-site` to skip
this half entirely, on a machine with no wrangler credentials.

## Reference

### Redoing a step

While a version is still a pre-release, repeating step 3 overwrites it: the
existing release and tag are deleted first, so what is published always matches
the commit that was just built. Any release notes you hand-edited on GitHub are
lost, and the script warns before doing it.

**Once promoted, a version is immutable** — republishing is refused, because
people may already hold that installer and its published checksum. Correct a
promoted release by bumping `VERSION`.

### One-time Mac setup

Needed to *release* from the Mac, not to build on it — `pnpm app` needs none of
this:

- Apple Developer Program membership, with a **Developer ID Application**
  certificate in the login keychain (pass `--identity` if its name isn't the
  default `Developer ID Application`).
- A notarytool keychain profile named `plectrify`:
  `xcrun notarytool store-credentials plectrify --apple-id <id> --team-id <team>`
- An authenticated `gh` CLI.

`packaging/` and `ui/` install themselves from the script (`--frozen-lockfile`),
so the root `pnpm install` is the only one to run by hand.

### Commands and flags

`scripts/release.ts` dispatches on platform, the way `scripts/run.ts` does for
`pnpm app`, and
announces which step it is running. There is only one half of a release you
*can* do on a given OS, so naming the platform was restating what the machine
already knew. Promotion stays its own command because steps 2 to 4 produce
artifacts — safe to repeat — while promotion is the irreversible sign-off.

The platform scripts and their flags remain for awkward cases;
`pnpm release` forwards flags untouched, and an explicit `--pre-release` or
`--promote` is honoured rather than overridden. `ui/package.json` keeps
`release` / `release:promote` / `release:build` shortcuts for when you are
already in `ui/`.

The version always comes from `VERSION`. There is a `--version` flag, but it can
only agree or abort — it is compared against the file and never overrides it, so
its whole job is to fail in a second when you thought you had bumped it and
hadn't.

`--skip-tests` exists for iterating on packaging problems locally and cannot
ship: pairing it with `--pre-release` (Windows) or an upload (macOS) is refused.

### Toolchain and offline builds

- The Windows script bootstraps **Inno Setup** when missing (via `winget` or the
  signed official installer, signature-verified).
- The x64 **WebView2** installer and **Visual C++ redistributable** are
  downloaded into the gitignored `.release-cache/`, with URLs and SHA-256 hashes
  pinned in `packaging/windows/dependencies.json`. If Microsoft refreshes an
  "evergreen" URL, verify the new installer and update the manifest.
- Building offline: pass known-good local files via `--webview2-installer`,
  `--vcredist-installer` and `--inno-setup-installer`.
- Publishing and promoting need an authenticated GitHub CLI (`gh auth login`).

### Licensing

Nothing to do by hand. The scripts verify the AGPLv3 text and the JUCE
patch set, and publish the corresponding-source archive alongside every
installer. The obligation this carries is to keep that archive available
wherever an installer is offered — see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
