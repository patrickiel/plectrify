# Plugin catalogue

The **Packages** panel doesn't ship with the app — Plectrify fetches this
catalogue from Cloudflare R2 at runtime. So adding, updating or removing a
plugin needs no new Plectrify release, just a publish.

`catalogue.json` is the source of truth. Debug builds read it straight from
here, so the dev loop is: edit the JSON, restart the app.

```sh
pnpm --dir packaging install     # once
```

## A plugin released a new version

First, is there anything to do?

```sh
pnpm --dir packaging check-updates
```

It reports each platform's pin separately: a package's payloads live in
`assets`, one entry per platform (`windows-x64`, `macos-arm64`), and upstream
ships them on its own schedule.

**Most plugins** — the new version is on the project's own release page. Update
`version` plus the `url`, `sha256` and `downloadBytes` of each platform's asset
in `catalogue.json`, then [publish](#publish). Always together, never one
without the others — and if only one platform has a new build, leave the other
asset alone and wait, because the single `version` has to describe both.

**Neural Amp Modeler** is different: upstream publishes no usable binaries, so
we compile it ourselves — once per platform. On the Windows box:

```sh
pnpm --dir packaging build-plugin -- \
  --id neural-amp-modeler \
  --repo https://github.com/sdatkinson/NeuralAmpModelerPlugin.git \
  --tag v0.7.16 \
  --vst3-sdk <copy the sha from the current PROVENANCE-windows-x64.txt>
```

And on the Mac, same tag, same SDK pin:

```sh
pnpm --dir packaging build-plugin -- \
  --id neural-amp-modeler \
  --repo https://github.com/sdatkinson/NeuralAmpModelerPlugin.git \
  --tag v0.7.16 --vst3-sdk <same sha> \
  --project NeuralAmpModeler/projects/NeuralAmpModeler-macOS.xcodeproj \
  --scheme <vst3 scheme> --bundle NeuralAmpModeler.vst3
```

Each takes ~20 minutes, mostly compiling. Neither will upload a plugin that
fails Steinberg's VST3 conformance check. Each prints its own `assets` entry —
`windows-x64` and `macos-arm64` — and they go in together, in one publish,
because the shared `version` has to describe both binaries.

**A release that can't be unzipped to a `.vst3`** — a Windows installer, or a
mac `.dmg`/`.pkg`, which is most of them — can't be pointed at directly. Run
`host-plugin` on that platform's machine and it extracts every VST3 bundle in
the payload and re-hosts them. On a Mac nothing from the payload is executed;
on Windows the installer genuinely runs, so read what that does before you use
it:

```sh
pnpm --dir packaging host-plugin -- \
  --id <id> --version <v> --url <the .dmg/.pkg> --sha256 <its hash>
```

It prints an `assets` entry carrying `selfHosted: true`, because from then on
we serve that platform's bytes. Only that platform: the other one keeps
whatever it had, which is how Dragonfly Reverb is a re-host on macOS and a
plain link to the project's release on Windows. On a Mac, add `--bundle` (once
per name) if the payload holds a VST3 the package should not ship.

Before you run it, skim the release notes. If the release pulled in a new
dependency under a restrictive licence, we may not be allowed to host the
result at all — that's a judgement call the script can't make.

## Our own patches or captures changed

They're authored under `content/`. A folder with a `patch.json` in it is one
patch — its knob layout, its tone, and an `assets/` folder holding the capture
or IR it loads, so it installs as one self-contained thing. A patch bakes the
install path into its saved tone, so it is authored once per platform, in a
folder named for that platform:

```
content/amalgam-jtm45.windows-x64/
  patch.json
  assets/BNO JT45DR I Crunch BAL CAB3.nam
content/amalgam-jtm45.macos-arm64/     # the same patch, re-saved on a Mac
```

Anything that bakes no paths (loose captures, IRs) needs no such split and
lives in a plain `content/<packageId>/`, whose one archive serves every
platform.

Name the package for what a guitarist installs (`amalgam-jtm45`, "JTM45"), not
for how it's packaged. Edit the folder, then:

```sh
pnpm --dir packaging host -- --author amalgamaudio
```

That's the whole thing, for every pack we author, on whatever platforms it has
folders for. It rebuilds each one, skips any whose files haven't changed, and
for the rest uploads a new version and writes the `version` and every
platform's whole asset into `catalogue.json` itself — so there's nothing to
paste, and no way to publish one platform's new archive while the other stays
pinned to last week's. Add `--dry-run` to see what it would do, or
`--id <packageId>` for just one.

Adding a new patch is a new folder plus a catalogue entry, and a first release
keeps the version you wrote (`sha256` of all zeroes means "never published").

Give the entry a **`dependsOn`** naming the plugin the patch was built for —
one package id, not a list. Installing the patch then installs that plugin
first, and installing the plugin on its own brings no patches. The plugin's own
entry says nothing about patches at all, which is the point: adding or revising
one never touches its pin, hash or provenance.

**Authoring a patch that carries an asset takes one round trip**, and there's
no way around it: the plugin bakes the asset's absolute path into its own opaque
state, so the path has to be the installed one before you save. On Windows: put
the asset in `content/<id>.windows-x64/assets/`, run `host`, install the
package, point the plugin at `C:\ProgramData\Plectrify\patches\<id>\assets\…`,
save the patch in Plectrify, and copy the resulting `.patch` from
`%APPDATA%\Plectrify\patches` over `content/<id>.windows-x64/patch.json`. Then
rebuild.

**And every platform needs its own round trip**, because the baked path differs:
on a Mac the same steps run against `/Users/Shared/Plectrify/patches/…`, saving
out of `~/Library/Application Support/Plectrify/patches`, and the result is
committed as `content/<id>.macos-arm64/`. `host` builds each folder into that
platform's `assets` entry; a patch package with no folder for a platform is
simply not offered there. It refuses a patch in a bare `content/<id>/` rather
than guess which root it was saved against — that is what the platform suffix
is for. Packs of loose captures or IRs bake no paths, so they keep the plain
folder and `host` points every platform at their one archive.

Then [publish](#publish).

## Publish

```sh
pnpm --dir packaging validate -- --verify-assets
pnpm --dir packaging publish-catalogue
```

The signing key is found at `~/.plectrify/catalogue-signing.key`. Keep it
somewhere else and either set `PLECTRIFY_SIGNING_KEY` or pass `--key <path>`.

Then commit — publishing bumps `revision` and rewrites `catalogue.json.sig`,
and the repo should match what's live.

Finally, install the plugin once through the Packages panel. It's the only
thing that exercises the whole path a user takes.

## Three rules

**Never hand-edit a hash.** It's what authorises a DLL to load into Plectrify's
process. It comes from the tool that produced the file, or it's a guess.

**Never re-host a plugin to fix a dead link.** Who distributes a binary is a
licensing question, not a hosting convenience. A GPL plugin we host on even one
platform obliges us to keep its corresponding source published and pointed at
by `sourceUrl`, for as long as we offer the binary; `validate` will stop you
without it.

**The signing key lives offline** — and backed up. Not in this repo, not in CI;
`keygen` refuses to write one into the working tree. Losing it means no shipped
build will ever accept a catalogue update again. If the shipped
public key and the live signature ever drift apart, every user silently stops
getting catalogue updates — `verify-live` is what catches that.

## Other commands

| | |
|---|---|
| `validate` | schema and licence rules |
| `validate -- --verify-assets` | also re-download everything (all platforms) and re-hash it |
| `test` | archive-determinism suite for the reproducible zipper |
| `verify-live` | does the app's built-in key accept what's published? |
| `host-plugin` | re-host a release that can't be unzipped to a `.vst3` — an installer on Windows, a `.dmg`/`.pkg` on a Mac. Builds whichever platform you run it on |
| `build-plugin` | compile a source-only plugin, for whichever platform you run it on |
| `host-content` | rebuild the cabinet IR pack |
| `host` | rebuild every pack we author from `content/`, and re-pin what changed |
| `setup-r2` | create or repair the bucket and its custom domain (safe to re-run) |

The bucket is served from **`cdn.plectrify.com`**, not from its `r2.dev` dev
URL. That dev URL is still enabled and must stay that way: builds up to v0.1.0
have it compiled in, and both addresses serve the same objects at the same
keys. Point nothing new at it. The address itself is written once each side —
`R2_PUBLIC_BASE` in `scripts/pack.ts` for the tooling, `PLECTRIFY_CATALOGUE_URL`
in `CMakeLists.txt` for the app — and the two must agree, which is what
`verify-live` checks end to end.

Deeper background — why each rule exists, and what to watch for when changing
the tooling — is in [AGENTS.md](../AGENTS.md).
