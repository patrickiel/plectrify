# AGENTS.md — `packaging/`

Guidance for AI coding agents working on the plugin catalogue's tooling. It
continues the root [AGENTS.md](../AGENTS.md), whose *Plugin catalogue* section
says what the catalogue is — one `packages` list, `kind` against `category`,
per-platform `assets`, the trust root — and how the app consumes it.
[README.md](README.md) is the short human runbook — the commands to run for a
version bump or a publish. What follows here is the reasoning behind them: read
it before changing the tooling itself.

## Tooling

Tooling is TypeScript run through `tsx` (not PowerShell) so the shared parts
work on macOS and Linux as well as Windows — the same rule the root dev/release
scripts now follow; PowerShell survives only as a subprocess utility for the
few Windows-native queries (WMI, Event Log, Authenticode, elevation) in
`scripts/windows.ts`:

```sh
pnpm --dir packaging install
pnpm --dir packaging validate                  # schema + licence rules
pnpm --dir packaging validate -- --verify-assets   # also re-download and re-hash (all platforms)
pnpm --dir packaging test                      # node:test suites (archive determinism)
pnpm --dir packaging setup-r2                  # create/repair the bucket (idempotent)
pnpm --dir packaging keygen                    # once, ever
pnpm --dir packaging publish-catalogue         # key: ~/.plectrify/catalogue-signing.key
pnpm --dir packaging check-updates             # are any pins behind upstream? (per platform)
pnpm --dir packaging verify-live               # does the shipped key accept what is live?
# One command each, whichever machine you are at: it builds this platform and
# writes this platform's assets[<slug>] entry. Run both machines per release.
pnpm --dir packaging host-plugin -- --id <id> --version <v> --url <upstream> --sha256 <hash>
pnpm --dir packaging build-plugin -- --id <id> --repo <git url> --tag <tag> --vst3-sdk <sha>
# ...plus what xcodebuild needs, when build-plugin is run on a Mac:
#   --project <path.xcodeproj> --scheme <scheme> --bundle <Name.vst3>
```

`check-updates` answers "is this pin outdated?" with evidence, independently
per platform a package declares. A newer *tag* is not a newer pin: several of
these projects cut source-only releases, and one publishes to a rolling tag
whose asset is replaced in place. It reports the newest release that actually
carries that platform's asset, and compares by asset URL so a rolling tag is
not always "behind" — a project can ship a new Windows build and no mac build,
or vice versa. The exception is a package marked `builtFromSource`, where a
source-only tag *is* a valid upgrade target for every platform we build —
without that flag the per-OS asset filter would hide the newest buildable
release and name an older one as "newer", advising a downgrade.

`host-content` builds the cabinet-IR pack (a `kind: "content"` package). It
selects impulses by reading each WAV's sample rate from its header rather than
by filename, because these packs ship the same impulses at two rates in folders
named for them — matching on the path would silently pick the wrong set if a
folder were ever renamed.

`host-plugin` is for a plugin whose release cannot be unzipped to a `.vst3`.
Every catalogue asset must yield one by unzipping alone — the app will not run
a third-party installer — so for those the bundle is extracted once and
re-hosted, with a `PROVENANCE-<slug>.txt` recording where it came from. Only
for licences that permit redistributing the binary; `validate` refuses a
self-hosted copyleft plugin with no published source. Re-run it on each upstream
release rather than hand-editing a hash.

It is **one command that builds the platform it is run on**, and the three
halves behind it have nothing in common but their purpose. On Windows
(`hostPlugin.windows.ts`) it is the rare case and the invasive one: the upstream
installer is genuinely run on this machine, each VST3 it added or changed is
copied out, and it is uninstalled — with every pre-existing bundle backed up
first, fingerprinted by content rather than by name, and restored afterwards.
Nothing is uploaded if that cleanup does not complete. On macOS
(`hostPlugin.macos.ts`) it is the *common* case — most mac releases ship a
`.dmg`/`.pkg` — and nothing is executed at all: a dmg mounts and a pkg expands
as plain data, and the bundle is copied out with its arm64 slice checked. That
guard is not ceremony either: a mac bundle's permission bits, framework symlinks
and signature seal would not survive extraction on another OS, and the result
would hash fine, validate fine and fail to load. On Linux
(`hostPlugin.linux.ts`) the payload is a tarball the app cannot unpack (it only
unzips), already in VST3 bundle layout: it is unpacked as plain data, each
bundle's `Contents/x86_64-linux/*.so` has its ELF header checked for x86-64 —
upstreams ship arm64, armhf, i686 and riscv64 tarballs side by side — and the
bundles are re-zipped with their exec bits. `--bundle` narrows the pick on
macOS and Linux alike (Surge's tarball carries the synth beside the effects
rack); the link-safe walk and that selection are shared in `hostPlugin.ts`.

`build-plugin` is the harder case: a project that publishes **no** binary for a
platform at all, only source. Neural Amp Modeler went that way after v0.7.13 — its
later tags are source-only and the author's own Windows builds moved to
"Gateway", a separately-copyrighted fork with no published licence that we
therefore cannot redistribute. So its MIT source is compiled here and the
resulting VST3 is hosted, which MIT plainly permits. Mark such an entry
`builtFromSource`, with a `sourceUrl` naming the exact tag and `selfHosted` on
every one of its assets — `validate` insists on all three, because a binary we
compiled exists nowhere else to mirror.

Building makes Plectrify the *producer* of a binary rather than its mirror, so two
things follow. Only ever build from a tag: a moving branch is not provenance.
And pin `--vst3-sdk` — upstream's `download-vst3-sdk.sh` takes the SDK from
`master` and then deletes its `.git`, so without the pin a rebuild silently gets
a different SDK and upstream's own builds cannot say which one they used.
`build-plugin` records the repo commit, every submodule SHA, the SDK commit and
the toolchain in the published `PROVENANCE-<slug>.txt`, and runs Steinberg's
VST3 validator against the binary before it will upload anything.

Like `host-plugin`, it is one command that builds the platform it is run on and
writes only that platform's `assets` entry: MSBuild with a discovered toolset on
Windows (`buildPlugin.windows.ts`), xcodebuild plus a codesign and an arm64
slice check on a Mac (`buildPlugin.macos.ts`). Everything that makes the result
defensible rather than merely convenient — the exact-tag clone, the submodule
record, the SDK pin, the validator gate, the reproducible archive — is shared in
`buildPlugin.ts`, so the two cannot drift on the rules that matter. Build both
from the same tag and the same `--vst3-sdk` before publishing: a package's
platforms share one `version`, so half a release is not a release.

## Releasing a new version of a source-built plugin

This is the whole procedure when Neural Amp Modeler (or any `builtFromSource`
entry) cuts a release. The Windows build runs on Windows, the mac build on a
Mac, each about 20 minutes, most of it compiling; both land in the same
catalogue entry under the same `version`, so do them as one publish.

1. **Confirm there is something to do.** `pnpm --dir packaging check-updates`.
   For a `builtFromSource` entry this compares against the newest release of any
   kind, because a source-only tag is a perfectly good build target — that is
   what the flag is for.

2. **Read the release notes before building.** A new tag can move the source
   somewhere we cannot follow: a dependency added under a copyleft or
   no-redistribution licence changes whether the result may be hosted at all.
   The licence audit is per release, not once ever.

3. **Decide the SDK pin.** Re-use the `--vst3-sdk` commit from the current
   `PROVENANCE-<slug>.txt` to change one variable at a time. Take a newer SDK only
   deliberately, and then say so in the commit message.

4. **Build.** One command per platform does clone, build, validate, archive,
   provenance and upload:

   ```sh
   # Windows box:
   pnpm --dir packaging build-plugin -- \
     --id neural-amp-modeler \
     --repo https://github.com/sdatkinson/NeuralAmpModelerPlugin.git \
     --tag <new tag> --vst3-sdk <sha from PROVENANCE-windows-x64.txt>

   # Mac:
   pnpm --dir packaging build-plugin -- \
     --id neural-amp-modeler \
     --repo https://github.com/sdatkinson/NeuralAmpModelerPlugin.git \
     --tag <new tag> --vst3-sdk <same sha> \
     --project NeuralAmpModeler/projects/NeuralAmpModeler-macOS.xcodeproj \
     --scheme <vst3 scheme> --bundle NeuralAmpModeler.vst3
   ```

   Both refuse to upload a binary that fails VST3 validation. Add `--no-upload`
   to rehearse, but note that a rehearsal cannot be promoted: the build is not
   bit-reproducible, so the real run produces a different binary and you must
   take that one's hash.

5. **Update the entry** in `packaging/catalogue.json`: each build's `url`,
   `sha256` and `downloadBytes` go into its own `assets` entry — all three
   together, never one without the others — and both, with the shared
   `version`, in the same publish, so that `version` never describes one
   platform's binary and not the other's.

6. **Verify and publish.**

   ```sh
   pnpm --dir packaging validate -- --verify-assets
   pnpm --dir packaging publish-catalogue
   ```

   `publish-catalogue` bumps `revision` itself; commit the bumped revision and
   the `.sig` so the repo matches what is live.

7. **Install it once through the Packages panel** before calling it done. A
   Debug build reads `packaging/catalogue.json` straight from the source tree
   (unsigned — see `CatalogueInstaller.cpp`), so this can be exercised before
   publishing as well as after. The validator proves the plugin is a conformant
   VST3; only an actual install exercises the download, the hash gate, the
   `include` patterns and the scanner.

If a build ever fails to validate, do not publish it and do not "fix" it by
skipping validation. Diagnose it against the toolset first: the version the
project pins is often absent from the build host, and `build-plugin` prints and
records the substitution it made.
