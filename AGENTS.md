# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Plectrify is a **guitar-rig VST3 host** for Windows and macOS (Apple
Silicon): a JUCE (C++17) engine that runs a user-ordered chain of VST3
plugins (amp sims, effects) live from a guitar input. It ships in two
shapes from one engine: the standalone application, and a VST3 plugin that
runs the same rig inside a DAW (`Source/plugin/`; core support — release
packaging for the plugin is still to come). The entire UI is a Svelte web
app rendered inside an embedded `juce::WebBrowserComponent` (WebView2 on
Windows, WKWebView on macOS); the C++ side owns all audio. Both builds read
the same per-user data root, so rigs, patches, installed packages and the
TONE3000 account are shared by construction.

A **module** in the rack is just a hosted plugin — it carries no built-in
semantics. The user gives it identity by mapping knobs onto the plugin's
parameters. A saved, named knob mapping — together with the plugin's own full
tone — is called a **patch** and can be re-applied to any module hosting the
same plugin.

Signal flow: `audio in → InputRouter (mono fan-out) → slot 0 → … → slot N →
OutputLevel (master gain/mute + meter) → out`. Bypassed slots are routed
around; an empty rack is a clean passthrough. Any number of sequential **split
groups** can fan the chain into parallel lanes (per-lane gain/pan/mute/solo,
optional exclusive lane switch) that sum before the next serial segment. A
background-thread **tuner** taps the input, and the whole chain — including
each plugin's binary state — saves/recalls as a named **rig**, and the
working rack autosaves so it restores on the next launch.

## Tech stack

- **Native app**: JUCE 8.0.14 (fetched via CMake `FetchContent`, pinned commit),
  C++17. Visual Studio 2022/18 generator on Windows; Ninja (or Makefiles) +
  Xcode CLT on macOS, arm64 only, deployment floor 13.3. VST3 hosting only
  (`JUCE_PLUGINHOST_VST3=1`; VST2/LADSPA are disabled in `CMakeLists.txt`).
  ASIO is on for Windows builds only (`JUCE_ASIO=1` behind `if(WIN32)`) using
  the ASIO 2.3 headers bundled with JUCE — no external SDK, no configure-time
  detection; macOS talks CoreAudio natively and has no ASIO at all.
- **UI**: Svelte 5 (runes) + TypeScript + TailwindCSS v4, built with Vite 6,
  packaged with **pnpm** (not npm).
- **Bridge**: JUCE web-view backend (WebView2 / WKWebView) with native
  integration; events over `window.__JUCE__` (no direct method calls across
  the boundary). The UI never learns which backend it is in beyond
  `AppInfo.platform`, a wording-only discriminator.

## Repository layout

```
CMakeLists.txt        # native app target, JUCE FetchContent, WebView2 wiring (Windows)
scripts/              # root dev/release tooling — every entry point `pnpm` runs
  run.ts              # `pnpm app` — dispatches to run.windows.ts / run.macos.ts
  run.windows.ts      # Windows dev loop; run.macos.ts is its mac twin
  release.ts          # `pnpm release` — dispatches by platform; `pnpm release:promote` is step 3
  release.windows.ts  # Windows release pipeline (Inno Setup installer)
  release.macos.ts    # macOS release pipeline (signed/notarized installer pkg)
  shared.ts           # helpers: OS-neutral (shared.ts) and per-OS (windows.ts, macos.ts)
Source/               # C++ — vertical slices, each folder is on the include path
  app/                # Main.cpp (app entry), MainComponent (standalone shell),
                      #   PlectrifyEngine (everything shared with the VST3 build),
                      #   HostServices.h (the engine's abstract host), EngineWebView
  audio/              # RackProcessor (AudioProcessorGraph wrapper), InputRouterProcessor
  plugin/             # the VST3 build: PluginProcessor (AudioProcessor + HostServices),
                      #   PluginEditor (the shared web view in a DAW's window)
  plugins/            # PluginManager (VST3 scan / cache / async instantiation)
  rackui/             # PluginEditorWindow (hosts a plugin's own editor)
  tone3000/             # TONE3000 account, its own browser window, downloads, NAM state codec
ui/                   # Svelte front-end
  src/lib/engine/     # EngineBridge.ts (contract), JuceEngine.ts, MockEngine.ts, types.ts
  src/features/       # rack/ (Rack.svelte), module/ (ModuleCard.svelte), knob/ (Knob.svelte),
                      #   setup/ (SetupWizard.svelte — first-run audio setup)
  dist/               # build output — served by the native app at runtime (gitignored)
site/                 # plectrify.com — static marketing + docs site (see site/README.md)
  src/routes/docs/    # one .md per page, wrapped by src/lib/docs/_docs.svelte
  src/lib/site.ts     # version, download URLs, video id — the product facts
third_party/          # vendored, gitignored: Microsoft.Web.WebView2 NuGet package (Windows)
build/                # CMake output (gitignored); exe at build/Plectrify_artefacts/<Config>/Plectrify.exe
build-macos-*/        # macOS CMake trees (one per config; single-config generators)
```

## Build and run

One dev-loop command on both OSes. `scripts/run.ts` dispatches to the platform
implementation; the tooling is all TypeScript run through tsx, so a single
`pnpm install` at the repo root is the whole setup. Prereqs beyond Node+pnpm:
Visual Studio 2022/18 with the C++ workload on Windows (`cmake` and `cl` need
**not** be on PATH — the script finds the VS-bundled binaries), Xcode Command
Line Tools + CMake (optionally Ninja) on macOS.

```sh
pnpm install         # once, at the repo root — fetches tsx
pnpm app             # dev loop: Vite HMR server + Debug app pointed at it
pnpm app --ui-only   # rebuild ui/dist + relaunch (no cmake)
pnpm app --dist      # ship path: UI format/check/test/build, cmake, native tests, launch
pnpm app --dist --no-ui    # skip the Svelte build (C++ only)
pnpm app --dist --no-run   # build + test only, don't launch
pnpm app --clean           # rebuild the native target from scratch
pnpm app --dist --config Release   # Release build (stages ui/ where the OS serves it)
pnpm app --plugin    # build the Debug VST3 and install it for this user's DAWs
                     #   (%LOCALAPPDATA%\Programs\Common\VST3 on Windows,
                     #   ~/Library/Audio/Plug-Ins/VST3 on macOS). Starts Vite
                     #   like the default loop; launch the DAW with
                     #   PLECTRIFY_DEV_URL=http://localhost:5173 in its
                     #   environment for live HMR. A Debug .vst3 needs no
                     #   staging — UI, catalogue and bundled plugins resolve
                     #   from the source tree. Note the copy step fails while a
                     #   DAW holds the bundle open: close the DAW first —
                     #   nothing can release a loaded .vst3 the way stopApp()
                     #   releases the exe. --plugin refuses --dist/--ui-only:
                     #   a Release .vst3 is staged and sealed by the release
                     #   pipeline, not the dev loop.
```

Platform notes: Windows builds into `build/` (VS generator, multi-config) and
carries two hazards the script owns — the MSBuild `.tlog` interrupted-build
marker and killing WebView2 orphans that hold the profile lock (see
`scripts/windows.ts`). macOS builds into per-config trees (`build-macos-debug`,
`build-macos-release`; Ninja/Makefiles are single-config) and must serve the
UI from `Contents/Resources/ui` in Release (see `provideResource`); Debug
keeps the source-tree `ui/dist` fallback on both OSes, so the dev loop copies
nothing.

**Window chrome is per-platform.** Windows gets Plectrify's own title bar, the
themed surface `WindowLookAndFeel` draws, with square caption buttons; macOS
uses the **native** title bar (`setUsingNativeTitleBar`). Do not port the custom
bar there. A borderless mac window gives up rounded corners, the system shadow,
Spaces, tabbing and full screen — AppKit refuses `toggleFullScreen:` for one,
which is why the maximise control did nothing — and buys only a bar that matches
the page's colours. On macOS `WindowLookAndFeel` is still installed, but only
`getWindowBackgroundColour()` is ever consulted; the title bar follows the
system appearance rather than the UI's theme, and that is the accepted trade.
The web page's edge strips (`WindowResizeHandles`) stay on both: the web view
covers the client area either way.

**The app icon** splits the same way. `ICON_BIG`/`ICON_SMALL` still feed the
Windows resource, while on macOS `cmake/MakeMacAppIcon.cmake` rebuilds the whole
.icns ladder from the same 1024 px art and overwrites JUCE's inside the bundle
(before either script codesigns, so it is inside the seal). That script's header
explains why the generated one will not do; the short version is that JUCE
writes only the sizes it was handed, and the art is full-bleed where Apple's
grid expects margins.

To drive CMake directly on Windows, use the VS-bundled binary (e.g.
`C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`):

```sh
cmake -B build                                  # first configure downloads JUCE (~1 min)
cmake --build build --config Debug --target Plectrify
```

- The run scripts kill any running `Plectrify` process before linking so the
  linker can overwrite the binary — do the same when building directly while
  the app runs.
- The app serves `ui/dist` at runtime, so **the UI must be built before the
  app can show anything**. Debug builds fall back to the source tree's
  `ui/dist` (via the Debug-only `PLECTRIFY_UI_DIST_DIR` compile definition);
  Release builds serve only the staged `ui/` — next to the exe on Windows,
  inside the bundle at `Contents/Resources/ui` on macOS (staged before
  codesigning — the tree is part of the seal). The run/release scripts stage
  it; so does the Windows installer.

### UI commands (in `ui/`)

```sh
pnpm install
pnpm dev      # http://localhost:5173 — standalone against MockEngine
pnpm build    # emits ui/dist/ — the ship path
pnpm check    # svelte-check type check
pnpm format   # Prettier + Tailwind class sorting
pnpm format:check # verify formatting without changing files
```

### Website (`site/`)

`plectrify.com` — a **fully static** SvelteKit site (adapter-static) served by
an **assets-only Cloudflare Worker**: no server, no database, no
authentication. It is a fourth independent package alongside root tools, `ui/`
and `packaging/`, and the native build neither depends on it nor is depended on
by it.

```sh
pnpm --dir site install    # must run in site/, see below
pnpm --dir site dev        # http://localhost:5173
pnpm --dir site build      # → site/build/, the folder the Worker serves
pnpm --dir site check      # svelte-check
pnpm --dir site run deploy # build, then publish to plectrify.com
```

`www.plectrify.com` 301s to the apex via a proxied CNAME and one Cloudflare
redirect rule, both in the dashboard and neither in this repo — a redirect is
not a deploy, and the edge answers it before any Worker runs. DNS alone could
not: a CNAME makes www *arrive*, and knows nothing of paths or status codes.
`site/README.md` records the rule, since nothing in git will.

`wrangler.jsonc` declares the Worker: `assets.directory` and a custom-domain
route, and deliberately **no `main`** — with no script, every request is
answered by Cloudflare's asset server rather than by code that has to stay
correct. `static/_headers` (caching plus two security headers) is read verbatim
there as it was on Pages, and `not_found_handling` is left at its default so an
unmatched URL is a real 404 — the same reason `fallback` is unset in
`svelte.config.js`. Note `deploy` needs `pnpm run`: bare `pnpm deploy` is one of
pnpm's own subcommands. `wrangler` uploads whatever is in `build/`, so
`wrangler.jsonc` declares `build.command` and wrangler runs `pnpm build` itself
before every `deploy`/`versions upload` — neither a stale local `build/` nor a
CI clone with none at all can ship the wrong thing.

`site/` carries its own `pnpm-workspace.yaml`, whose only job is to make it a
pnpm root. pnpm walks up from the invocation directory looking for one, so
without it the repo root's file is found and the install silently succeeds
having done nothing. **`ui/` and `packaging/` have the same exposure** — if
either ever reports "Already up to date" with no `node_modules`, that is the
cause and the fix is the same file.

Two things about its content are load-bearing:

- **Docs are `.md`** under `src/routes/docs/`, wrapped by
  `src/lib/docs/_docs.svelte` via mdsvex. A new page is a file **plus** an
  entry in `src/lib/docs/nav.ts` — the hand-ordered table of contents, which
  also drives the sidebar and the prev/next links. Use fenced code blocks for
  the ASCII signal-flow diagrams; an indented block does not survive mdsvex.

Design tokens are lifted from `ui/src/app.css` under the *same names*, and the
Inter and JetBrains Mono woff2 files in `site/src/lib/fonts/` are copies of the
app's (in `src/lib`, not `static/`, so Vite fingerprints them and
`hooks.server.ts` can preload them). The site is dark only; the app has both
themes.

### Plugin catalogue (`packaging/`)

**One plugin is shipped rather than offered.** Neural Amp Modeler lives in
`packaging/bundled-plugins.json`, not in the catalogue: both release scripts
download the pinned archive, check its SHA-256 and stage the `.vst3` into the
installation — `{app}\plugins` on Windows, `Contents/Resources/plugins` inside
the mac bundle (inside the signature seal, and signed itself before the app is).
`PluginManager::getBundledPluginDirectory()` is always on the scan path, and
`scanBundledPluginsIfNeeded` scans **that directory alone** at startup when what
is in it is not in the cache yet — scanning is user-triggered everywhere else
because it loads code the user chose to install, but this binary is ours, in our
folder, put there by our installer, and an app that assumes it is present cannot
also ask the user to press Rescan first. The dev loop stages the same pinned
archive into `third_party/plugins` (`pnpm app`), because a Debug tree has no
installation to stage from and there is no longer a panel to install it from. It is
bundled because every TONE3000 tone is a capture that loads into it, and a
browser for a catalogue of captures with nothing to play them in is half a
feature; a plugin the app *assumes* is present has no business being one the
user might not have installed. It is therefore never listed by the Packages
panel, cannot be uninstalled from inside the app, and goes when the app goes
(unlike catalogue plugins, which are the user's). A machine that installed it
from the panel under an older version has its copy retired once at startup
(`CatalogueInstaller::retirePackageAsync`, guarded on the bundled copy actually
existing) so the plugin list does not show it twice. Bundling makes Plectrify the
distributor, so its MIT notice and source pointer are in
`THIRD_PARTY_NOTICES.md` and in both SOURCE_OFFER texts. Updating it is a
rebuild with `build-plugin`, an upload, and a new version/url/sha256 in that
file — the catalogue is not involved.

**A fresh installation installs the starter bundle by itself**, once, without
being asked. An app whose rack accepts anything and whose drawer offers nothing
is not a product on the first launch, and the bundle is already the answer the
Packages panel gives — so the page gives it unprompted rather than making the
first act of playing guitar a shopping trip. The rule is one pure function
(`ui/src/lib/engine/starterBundle.ts`, tested), and the engine — not a panel —
asks it when a catalogue push arrives: the panel may never be opened, and this
is the one install nobody clicked.

Three details carry it. It is **attempted once, not until it succeeds**:
`AppSettings.starterInstallAttempted` is written *before* the run, so a failed
or half-finished download leaves the user with the panel's own Install bundle
button rather than a fetch that re-arms on every launch. It **settles without
installing** when any package is already installed, because that machine is not
new whatever settings.json says — and `normalizeAppSettings` reads a stored
settings object with no such field as *already attempted*, since a settings file
existing at all means the app has been used here; only its absence (where
normalize is never reached and the defaults stand) is a first run. And the
decision **waits for the stored settings** (`appSettingsLoaded`), because the
defaults claim the install has not happened. Members this platform is not
offered are dropped rather than queued — a bundle is one list of ids on every OS
(see `packaging/catalogue.json`), and macOS is offered two of the five. The
empty rack says what is happening for the minutes it takes
(`subscribeStarterInstall` → `Rack.svelte`); per-package progress stays where it
already lived, in the Packages panel.

**That one run ends with a full scan**, not the narrow one every other install
gets: the page sets `rescanAll` on the `installPackages` event and
`MainComponent::requestFullRescan` walks the whole search path. It is the same
first-run reasoning — a machine that has never been scanned knows about no VST3
anywhere, so the plugins the user already had in their own folders are found in
the same step as the ones just downloaded, instead of waiting for them to press
Rescan. The narrow scan's argument (one folder of ours, fast enough that the
drawer catches up) still holds everywhere else and is unchanged. The full walk
runs even when the download failed — the folders are worth reading whatever the
network did — and is queued behind a scan already in flight exactly as
`scanManagedPlugins` is, taking precedence over a pending narrow one since it
covers that directory too.

**A package run scans the managed directory alone**, never the whole search
path. `MainComponent::scanManagedPlugins` is what an install, an uninstall and
the retirement above all call: `PluginManager::getManagedPluginDirectory()` is
the only folder any of them can have written to, and one folder of ours scans
fast enough that the drawer catches up while the user is still looking at the
row they clicked. A full `scanForPlugins()` walks every VST3 folder on the
machine, instantiating each plugin in this process, and takes long enough that
the drawer once had to be covered with a "rescan to bring this list up to date"
pane while it ran — a pane over a list that the scan's own progress push had
already corrected. Removals are served just as well: every scan begins by
pruning known-list entries whose file is gone, wherever it lived, so the narrow
path costs nothing there either. The full scan stays for what it is for — the
user pressing Rescan, and retrying a blacklisted plugin. When the run lands,
the panel asks the drawer to scroll to what arrived and pulse it
(`revealPackageInDrawer`); the drawer waits out the scan rather than its usual
budget, since the thing named is not in the list until it ends.

The plugin packages the **Packages** panel offers are not compiled in: the app
fetches a signed JSON catalogue from Cloudflare R2 at runtime, so adding,
updating or removing a plugin — and its licence notices — needs no new Plectrify
release. `packaging/catalogue.json` is the single authoring source; Debug
builds read it straight from the source tree (`PLECTRIFY_CATALOGUE_FILE`), so
the dev loop is "edit the JSON, restart".

Everything downloadable is one `packages` list — VST3s and cabinet IRs alike —
and each entry carries two fields that look similar and must never be conflated:

- **`kind`** (`plugin` | `content`) is a *trust* decision. A `plugin` is unzipped
  into the VST3 load path and executed inside Plectrify's process; `content`
  unpacks into a plain data folder (`installDir`) and is never loaded as code.
  It is explicit and validated on both sides, never inferred from a category or
  from which other fields happen to be present — the catalogue arrives over the
  network, so anything that could move a payload into the load path is part of
  the trust root. `CatalogueInstaller` is the only place it is acted on.
- **`category`** is where the Packages panel files the entry, grouped by in
  first-appearance order and printed verbatim. Purely cosmetic. Name these for
  what a guitarist is after ("Amps", "Cabs & IRs", "Effects"), never for how the
  thing is packaged — `validate` rejects a category of "Plugins" or "Content"
  precisely because that invites the two fields to be read as one.

A category is either one heading (`"Effects"`) or a **path** of them
(`["Effects", "Reverb"]`), outermost first, which renders the last segment as a
subsection of the ones before it. Both forms are accepted everywhere, so a
section only grows a path once it needs dividing — Effects has, Amps has not.
An entry that spans every subsection stays on the parent (the multi-effect racks
sit under a bare `"Effects"`); the panel draws a parent's own rows above its
subsections. Nesting is display and nothing else: the same cosmetic field,
refused the same names at every depth, and no more able to move a payload than
before. It is also why this did **not** bump `schemaVersion` — a build too old
to read a path files those rows under "More downloads" and installs them
correctly, where a bump would leave it with no catalogue at all.

The same `category` field appears on `links`, and both lists are grouped by the
one `groupByCategory` in `catalogue.ts` — which builds the tree, creating a
parent node for a heading no entry sits directly under. So adding a section, at
any depth, is a category in the JSON and a publish — never a UI change.

**`tags` is the panel's filter chips**, and the second cosmetic field. It
answers a different question from `category` — what the thing *is*, not where it
is filed — and a package has one answer to the first and several to the second:
a multi-effect rack is a distortion and a delay and a reverb, and it still sits
in one section. Always an array (no bare-string shorthand: nothing predates the
field), refused the same `Plugins`/`Content` names at the same depth of
cosmetic-ness, and just as unable to move a payload. The chips were built from
the top-level heading until that showed its limit — with everything on offer
filed under "Effects" the row read "Effects 22" and narrowed nothing — so it did
not bump `schemaVersion` either: a build too old to read `tags` shows the panel
it always showed. Keep the vocabulary small and reuse it; a tag used once is a
chip that filters twenty-two rows down to one. Omitting it is legitimate and
means the entry answers to no chip (HISE, a build tool, is the one that does).

Links carry it too, and that is the point of putting it on them: a chip asks
what someone is after, and the honest answer to "amps" or "captures" is mostly
things Plectrify does not host — so a chosen chip narrows the link cards rather
than hiding them, and its count includes them. The narrowing *views*
(Available/Installed/Updates) still drop the links whole, because those ask
about the user's own disk, which no link is part of.

**Per-platform assets.** Every payload lives in `assets`, keyed by platform
slug, and **no platform is the default**:

```json
"assets": {
  "macos-arm64": { "url": "…", "sha256": "…", "downloadBytes": 123, "include": ["…"] },
  "windows-x64": { "url": "…", "sha256": "…", "downloadBytes": 456 }
}
```

Keys are written alphabetically so the file cannot be read as "Windows, plus
some others". At least one is required — a package offered nowhere is not a
package — and a platform with no entry is not offered it: the row renders
greyed with install disabled, visible rather than hidden, so the catalogue never
looks quietly thinner per OS. Selection is one map lookup of
`catalogueRuntimePlatform` (`CataloguePackage::assetFor`, acted on only in
`CatalogueInstaller`). An asset's `include` may be omitted to inherit the
package's, which is the usual case: `**/*.vst3/**` is layout-neutral, and
keeping one copy on the package is what stops two from drifting. Each entry
pins a hash that authorises code onto some platform's disk, so `validate`
applies the same rules to all of them and `--verify-assets` re-downloads them
all. One `version` covers every platform's payload, so a package's assets must
come from the same upstream release; `validate` also refuses a package offered
on a platform its `dependsOn` is not, which would queue an install that cannot
succeed.

This **is** `schemaVersion` 4. Windows used to live in flat
`assetUrl`/`sha256`/`downloadBytes` fields with `assets` holding only the other
platforms, and the asymmetry propagated: two code paths in every script that
touched a payload, a `validate` rule refusing `windows-x64` as a "second source
of truth", and a per-OS question that could only be asked one way round. Unlike
`category` gaining its array form, an older build cannot read the new shape and
get a slightly worse answer — it finds no `assetUrl` at all — so this bump is a
real one: builds predating it reject the catalogue outright and keep their
cached copy until updated. `Catalogue.cpp` says so by name rather than failing a
field at a time.

[`packaging/README.md`](packaging/README.md) is the short human runbook — the
commands to run for a version bump or a publish. What follows here is the
reasoning behind them: read it before changing the tooling itself.

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

It is **one command that builds the platform it is run on**, and the two halves
behind it have nothing in common but their purpose. On Windows
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
would hash fine, validate fine and fail to load.

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

#### Releasing a new version of a source-built plugin

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

- **The manifest is a trust root.** Its SHA-256 pins authorise DLLs to be loaded
  into this process, so it is signed and verification is mandatory. The private
  key lives offline, never in the repo or CI; the public half is a constant in
  `Catalogue.cpp`. `verify-live` is what catches the silent failure mode where
  those two no longer match.
- **Who distributes what is a licensing question, not a hosting convenience.**
  A package fetched from its own project leaves that project the distributor.
  The moment Plectrify hosts a copyleft binary, GPL §6 attaches to us and the
  corresponding source must stay published and pointed at — which `validate`
  enforces via the `selfHosted` flag. That flag sits on the **asset**, not the
  package: it is a fact about one url, so one platform can be a re-host while
  another is still a mirror (Dragonfly Reverb is), and one self-hosted asset is
  enough to require a `sourceUrl`. `validate` checks the flag against the url it
  sits on in both directions, so neither half of that pair can drift.
  Never "fix" a rotted URL by re-hosting.

### Optional dependencies

- **WebView2** (Windows only, behind `if(WIN32)`): the `Microsoft.Web.WebView2`
  NuGet package is downloaded and unpacked into `third_party/` automatically on
  first CMake configure (version and SHA-256 pinned in `CMakeLists.txt`), then
  found via `JUCE_WEBVIEW2_PACKAGE_LOCATION`. No manual bootstrap; building
  offline, place the extracted package there yourself. macOS needs nothing —
  WKWebView ships with the OS.
- **JUCE patches**: CMake applies three small patches from `cmake/` to the
  fetched JUCE tree, and **all are applied on both OSes** even though each
  fixes one — every patch is internally guarded, so there is one patched tree
  and one answer to what a binary was built from. `JUCE_PATCHES` in
  `scripts/shared.ts` is the single declaration: the patch file, the JUCE file it
  touches, and a marker string it introduces. Both release scripts' provenance
  gates read that (the marker proves it is applied; `JUCE_PATCHED_FILES`, the
  *distinct* files, proves nothing else changed — more than one patch may land
  in the same source, as the VST3 pair does), so **adding a patch means adding
  an entry there plus a `COMMAND` in `CMakeLists.txt`'s `PATCH_COMMAND`** —
  nothing else.
  - `juce-disable-webview2-zoom.patch` — 8.0.14 doesn't expose WebView2 zoom
    settings via its Options API. Windows-only file; no mac counterpart is
    needed (WKWebView ships with magnification off and the UI already
    suppresses ctrl/meta zoom keys and pinch-wheel).
  - `juce-vst3-no-mac-content-scale.patch` — JUCE reports a content scale
    factor to hosted VST3s on macOS, where `IPlugViewContentScaleSupport` does
    not apply (a mac view is measured in logical points and the plugin takes
    the backing scale from its own NSWindow). JUCE sends 1.0 and merely
    swallows the failure, which is fine for a plugin that refuses it — but a
    plugin that *obeys* it loses its real 2× scale and draws its UI at half
    size in the top-left quarter of its window. Every iPlug2 build before that
    interface was guarded to Windows does obey it, Neural Amp Modeler included.
  - `juce-vst3-scale-before-attach.patch` — the mirror-image problem on
    Windows/Linux. JUCE only learns the display scale through
    `NativeScaleFactorNotifier`, which reports via `MessageManager::callAsync`,
    so the real factor cannot land until after `view->attached()` — the call
    that makes a plugin build its UI — has already run against the 1.0
    placeholder. A plugin that re-reads the host's scale recovers a message
    loop later; DPF, iPlug2 and other older frameworks read it once, while
    constructing the UI, and so draw the whole editor at 1:1 for the life of
    the window (a little over half size on a 175% display). The patch asks the
    peer for the scale and reports it before attaching.
  - `juce-graph-host-owned-bypass.patch` — a bypass the host requested is
    enforced by `AudioProcessorGraph` itself instead of being delegated to the
    plugin. Stock JUCE, per the VST3 contract, sets the plugin's exported
    bypass parameter (`kIsBypass`) and keeps calling `processBlock`, trusting
    the plugin to pass audio through — and a plugin whose exported parameter
    is dead (Uhhyou's OrdinaryPhaser exports one and ignores it) then never
    bypasses at all; `processBlockBypassed` is no escape, since the hosted-VST3
    override routes it back into the same parameter. The patch makes the graph
    pass the buffer through itself whenever `Node::setBypassed(true)` was
    called, skipping the plugin's processing entirely (a hard bypass — tails
    do not ring out, which is the right trade for a rig's "pedal off"). A
    plugin bypassing *itself* through its own editor is untouched.
    `Tests/audio/BypassProbe.cpp` (manual, not a CTest) is how the dead
    parameter was proven; `testBypassIsHostOwned` in the rack tests pins the
    patched behaviour so a JUCE bump that loses the patch fails CTest rather
    than shipping.
  - `juce-no-double-escape-url.patch` — JUCE's mac web-view backend percent-
    encodes every URL handed to `goToURL()` with `URLQueryAllowedCharacterSet`,
    which does not contain `%`, so an escape already in the string is escaped
    again: `%3A` becomes `%253A` and the server decoding it once receives the
    literal text. The TONE3000 flow puts a URL inside a query parameter
    (`redirect_uri`), so it must be escaped and was answered with
    "redirect_uri must be a valid URL" quoting our own escapes back. The
    encoding exists to rescue a string that is *not* a valid URL, so the patch
    keeps it for exactly that case — try the string as given, escape only if
    NSURL rejects it. (Modern NSURL is lenient and encodes stray characters
    itself; the fallback is for the 13.3 floor.)

  After changing the JUCE tag, regenerate them all against the new sources and
  delete `build*/_deps/juce-*` so FetchContent re-populates. Editing a
  `PATCH_COMMAND` is enough to re-run the patch step on an existing tree —
  `ApplyPatch.cmake` treats an already-applied patch as success, so the others
  are not applied twice. But a patch *edited* in place is a different string in
  the same file: the tree still carries the old application, which now neither
  applies forward nor reverses, and the configure aborts naming the patch. That
  is what the rename from RigFlow left behind in every existing `_deps` tree, and
  it surfaces only when something else makes the patch step re-run. Reverting
  the affected files (`git -C build*/_deps/juce-src checkout -- <file>`) is the
  quick fix; deleting the tree is the thorough one.

## Architecture

### One engine, two hosts

Everything shared between the standalone app and the VST3 plugin lives in
`PlectrifyEngine` (`Source/app/PlectrifyEngine.{h,cpp}`): the rack graph, the
plugin library and catalogue, the TONE3000 slice, rig capture/apply, Auto
Standby's policy hookup, the sandboxed file I/O and both directions of the UI
bridge. It is deliberately **not** a `juce::Component` — a plugin editor is
created and destroyed freely while audio keeps running, so the engine outlives
any view. The host constructs its web view from
`engine->registerEventListeners(makeEngineWebViewOptions(...))` and attaches
it; every C++→JS push funnels through `PlectrifyEngine::emit()`, which quietly
drops events while no view is attached — a state the page's request/re-push
contract already recovers from.

Host-shaped questions go through **`plectrify::HostServices`**
(`Source/app/HostServices.h`), the engine's only route to anything the two
builds answer differently: sample rate/block size, CPU/xruns/device latency,
MIDI device names, the audio-settings and window events, whether Auto Standby
may engage, whether the host persists engine state, and the latency report
upward. `MainComponent` is the standalone implementation (it keeps the
`AudioDeviceManager`, `AudioProcessorPlayer`, `InputProbe`, `MidiInputManager`
and window handlers); `PlectrifyAudioProcessor` (`Source/plugin/`) is the
DAW-hosted one. `HostCapabilities` rides `appInfo` to the page (with
`host: 'standalone' | 'plugin'`), which gates the standalone-only surfaces —
setup wizard, device settings, window chrome, the Auto Standby card — behind
`appInfo.capabilities ?? STANDALONE_CAPABILITIES`, defaulting standalone-true
so the app can never flash a degraded layout before the push lands. The `host`
discriminator alone also rides the web view's initialisation data
(`registerEventListeners` bakes it into `window.__JUCE__` before the page's
first script runs), because the page's session-restore decision is one-shot
and a push can be dropped while the editor is hidden — which is how a DAW may
open one, and how pluginval found a page that guessed standalone and applied
the standalone's autosaved working rack over the DAW's session. Layout may
safely default; where the session lives may not.

**The plugin build** (`juce_add_plugin(PlectrifyPlugin ...)` — VST3
everywhere, plus AU on macOS for Logic and GarageBand, the hosts that load no
other format; the same `PLECTRIFY_ENGINE_SOURCES` and one
`plectrify_configure_target()` function, so the targets cannot drift on
definitions; `JUCE_ASIO` stays app-only) takes over the
`AudioProcessorPlayer`'s job in
`prepareToPlay`/`processBlock`, honouring the graph's suspension under its
callback lock exactly as the player did. Buses are mono-or-stereo in, stereo
out; the router always taps channel 0 (the DAW routes; the graph's render-time
clamp covers mono). The engine publishes graph latency on a diff every tick →
`setLatencySamples`, so the DAW's delay compensation tracks the chain — the
standalone's no-op keeps its behaviour unchanged. Host MIDI is collected
lock-free in `processBlock` and flushed to the page's `midiEvents` stream on
the engine tick with `MidiInputManager`'s exact coalescing rule, so MIDI learn
works unmodified — except in Logic, deliberately: the AU registers as a plain
effect (`aufx`, not JUCE's default `aumf`) because Logic files
"MIDI-controlled Effects" outside the Audio FX menu on audio tracks, the one
place a guitar rig must appear, and an aufx receives no MIDI there.
Discoverability wins; the trade is documented at the `AU_MAIN_TYPE` line in
`CMakeLists.txt`, and auval warns about the pairing and passes. Editor
resizing splits by format the same way: a VST3 window resizes by its host
frame (`IPlugView::canResize` is a real contract), but AUv2 gives a host no
way to learn a view is resizable, so no AU host offers the drag — and JUCE's
own corner grip sits beneath the native web view. The page therefore draws
its own grip in plugin mode (`EditorResizeGrip` → `setEditorSize` →
`HostServices::handleSetEditorSize` → the editor's `setSize`), the
plugin-initiated resize every host honours, GarageBand included. The plugin's
WebView2 profile is `WebView2-Plugin`, never the app's — two processes must
not share a profile lock. `moduleResourceDir()` in `AppPaths.h` is what lets
`provideUiResource` and the bundled-plugin directory resolve inside either the
exe's folder or a plugin bundle's `Contents/Resources` (`.vst3` and
`.component` alike).

**Host-saved state.** `getStateInformation` persists one JSON document
(`PlectrifyEngine::currentHostState()`): the rack in `applyRigEntries`' shape,
the split topology, the page's session blob, the fixed-node settings the
standalone keeps in `audio_settings.xml`, and the editor size. VST3 hosts may
ask off the message thread, so the engine keeps a capture cache refreshed on
its tick (rate-limited to ~2 s — a capture serializes every plugin's state)
and captures fresh when asked on the message thread. `setStateInformation`
applies through the ordinary rig-apply path under the load mute and its
watchdog; the load generation makes the latest state win over one still
applying. The page's session metadata rides the same document instead of
`working-rack.json`: the plugin build's page uses the `writeSession` /
`readSession` bridge events (engine memory), because a global file would be
fought over by two instances and dies with no one to read it when the DAW
project moves machines. On restore the plugin's page **adopts** the session's
metadata without re-applying the rack — the engine's rack is already live, and
rebuilding it on every editor open would cut audio. Auto Standby is never
driven in the plugin (offline render and freeze are the host's business); the
feedback guard, tuner, looper and metronome all remain.

Both release pipelines ship the plugin self-contained (`ui/` + the bundled NAM
in `Contents/Resources`): the Windows installer behind a default-on task into
`{commoncf64}\VST3`, the mac artifact as one installer pkg that always
installs every build — app to `/Applications`, sealed `Plectrify.vst3` to the
machine-wide `/Library/Audio/Plug-Ins/VST3`, sealed `Plectrify.component` to
`/Library/Audio/Plug-Ins/Components`. A pkg rather than a DMG because
that folder does not exist on a Mac that never had a VST3 installed (stock
macOS creates `Components` and `HAL` under `/Library/Audio/Plug-Ins`, never
`VST3`), so a disk image's drag target dangles on exactly the machines a first
install meets; `customize="never"` makes an app/plugin version skew
unrepresentable, the Windows `[InstallDelete]` promise by other means. The
Steinberg VST3 SDK notice electing GPLv3 is in `THIRD_PARTY_NOTICES.md`,
ASIO-notice pattern. Still to come: out-of-process scanning — Rescan inside a
DAW still loads plugins in-process, where a crashing plugin takes the host
down.

### UI ↔ engine contract

`ui/src/lib/engine/EngineBridge.ts` is the single contract between UI and
audio engine. Two implementations exist:

- `MockEngine` — in-memory stand-in for browser development (patches in
  `localStorage`).
- `JuceEngine` — talks to the real engine over `window.__JUCE__`.

`App.svelte` picks one at startup via `juceAvailable()`. **The UI never imports
JUCE and never changes when moving between mock and real audio** — keep all
engine-specific behaviour behind the bridge.

### Event-only bridge

No method calls cross the boundary — everything is named events:

- **JS → C++**: `backend.emitEvent(id, payload)`; handled by the
  `withEventListener(...)` registrations in
  `PlectrifyEngine::registerEventListeners` and its `handle*` methods (e.g.
  `insertModule`, `replaceModule`, `setParam`, `watchParams`, `openEditor`,
  `scanPlugins`, `installPackages`); host-owned events (`openAudioSettings`,
  `setAudioDevice`, `startWindowResize`…) are delegated to `HostServices`,
  where the plugin build inherits harmless no-ops.
- **C++ → JS**: `emitEventIfBrowserIsVisible(...)`. `rackChanged` pushes the
  full rack state after structural changes; `paramValues` streams live knob
  values (a 15 Hz `juce::Timer` in `MainComponent` polls parameters so UI knobs
  track a plugin's own editor). A patch's knob mapping is TS-owned metadata
  (persisted via the engine's generic file I/O), so it never crosses the bridge
  as a dedicated event; its *tone* half does, because only C++ can reach a
  plugin's state — see `captureModuleState`/`applyModuleState` below.
- **Request/response**: a few flows correlate by `requestId` — `captureRig` →
  `rigCaptured`, `applyRig` → `rigApplyProgress`/`rigApplied`, `readFile` →
  `fileRead`/`fileReadChunk`, `writeFile` → `fileWritten`, `listFiles` →
  `filesListed`, `captureModuleState` → `moduleStateCaptured` (one module's tone,
  for a patch; the whole-rack `captureRig` would move every other plugin's
  state too). `JuceEngine.request()` times out an unanswered request (replies
  ride `emitEventIfBrowserIsVisible` and can be dropped), so keep both sides of
  any new pair in the same change.
- **Long-running streams**: `installPackages` deliberately does *not* use
  `request()` — a plugin download runs for minutes, far past its timeout.
  Progress arrives as a plain `installProgress` stream and
  `installFinished` marks the end. Because that terminal event can be
  dropped while the window is occluded, the run is always followed by a fresh
  `catalogueState` push, and the panel reconciles from that (disk truth)
  rather than trusting the stream to have arrived intact. Copy this shape for
  any future operation measured in minutes.

When adding a UI↔engine capability: add the method to `EngineBridge`,
implement it in **both** `MockEngine` and `JuceEngine`, pick a matching event
name, and wire the handler in `PlectrifyEngine` (or through `HostServices`,
if only one host can answer it — then the other inherits the no-op and the
page hides the surface behind `HostCapabilities`).

### Audio (C++)

- `RackProcessor` (`Source/audio/`) wraps a `juce::AudioProcessorGraph`. Each
  `Slot` = one plugin node + its `KnobMapping`s. `rebuildConnections()` wipes
  and relinks the serial chain, skipping bypassed slots. **All graph mutations
  (add/remove/move/bypass) happen on the message thread and suspend audio
  processing while editing** — never touch the topology from the audio thread.
  Sequential split groups fan the chain into parallel lanes (per-lane
  `LaneMixProcessor` with atomic gain/pan) that sum before the next serial
  segment; lane-mix changes are atomics and need no audio suspension.
- `InputRouterProcessor` — fixed first node; copies its first channel onto both
  (a guitar is mono) and applies input gain. **Which hardware jack that is comes
  from upstream**: the device is opened with *every* input channel enabled and
  `rebuildConnections` taps the graph's input node at
  `RackProcessor::setInputSourceChannel`'s pin, wiring that one pin to both of
  the router's. So changing input is one edge moved, not a device restart — the
  only reason the setup wizard can offer the choice against live meters — and
  the router itself never learns a channel index. The pin is clamped at render
  time, so a saved choice survives a move to a smaller interface, and it is
  persisted in `audio_settings.xml` beside the device it indexes into.
- `OutputLevelProcessor` (same header) — fixed final node: master gain, meter,
  and **five independent mute reasons** (MIDI tuner, rig load, standby, feedback
  guard, the user's own mute), each its own atomic so none clears another's. The
  feedback guard is the only *latching* one: nothing in the engine ever releases
  it — a rig is an acoustic loop, so an automatic release would just re-enter
  it. The status bar's `MUTE` pill is the only way out, and the click is the
  player saying they have turned something down.

  The user's mute is deliberately **not** that latch written by hand: disarming
  the guard drops the latch, and a rig muted on purpose must not come back up
  because of it. It is the one mute reason the page owns outright
  (`StatusState.outputMuted`), it is transient — no session starts muted — and
  the guard stands down while it is engaged, since nothing reaches the speaker
  for a loop to close through. The `MUTE` pill is always on the bar, amber for a
  hand mute and red for a trip; the guard's on/off, its explanation and the
  mute's own MIDI learn (`outputMute`) live in a slideout above it, built like
  the tuner's. That footswitch is ungated in both directions — a panic control
  that a modal could swallow is not one.

  **Loudness is not the test, and assuming it was is what made the first version
  useless.** It required RMS ≥ -3 dBFS, on the theory that a runaway loop
  saturates. Real feedback often does not: a high-pitched squeal is close to a
  sine, and one sitting at -8 dBFS peak is about -11 dBFS RMS — painful, and
  nowhere near that threshold. What actually separates feedback from playing is
  that it does not *move*: a note decays, a chord changes, a loop finds its level
  and holds it. So the slow path looks for a level that is audible (≥ -20 dBFS
  RMS, above a high-gain amp sim's idle hiss, which is itself perfectly steady)
  and does not *fall* — never sagging more than 4 dB below its own running peak
  — for 1 s. The saturated case keeps a fast path of its own at 0.3 s.

  **Rising is free, and that is half the speed.** An earlier version asked for a
  level confined to a window, which meant a squeal that took half a second to
  build restarted the count the whole way up and was charged the build time on
  top of the dwell. Only a drop ends a run now, so counting starts the moment
  the loop crosses the floor. The sag allowance and the dwell are the two dials:
  raise either if playing ever trips it, lower the dwell if it feels slow.

  Detection reads the *incoming* buffer, ahead of the fader and the mute ramp,
  and stands down whenever another mute reason is engaged — a half-built chain
  during a rig load is not evidence of anything. Arming is persisted in
  `audio_settings.xml`; the latch deliberately is not. It is **off by default**
  and labelled Beta in its slideout while the detector is still being tuned
  against real rigs: a guard that mutes a rig it should not is worse than one
  the player turned on deliberately. Both defaults — the atomic's initialiser
  and `audio_settings.xml`'s fallback — must agree, plus the page's
  `defaultStatus`.

  ⚠ These are header-inline functions, so **editing this header alone is not
  enough**: MSBuild will not recompile a `.cpp` whose headers changed, and the
  linker then folds in a stale object's copy of the old code. Symptoms are
  bizarre — new tests exercising old logic, `printf`s that never appear. Touch
  the `.cpp` files (`find Source Tests -name '*.cpp' -exec touch {} +`) or build
  through `pnpm app`, which handles it.
- `TunerDetector` (`Source/audio/`) — YIN pitch detection on a worker thread
  fed by a lock-free FIFO tapped off the input.
- `InputProbe` (`Source/audio/`) — a **second `AudioIODeviceCallback`**, beside
  the `AudioProcessorPlayer`, holding one peak per *device* input channel.
  Deliberately outside the graph: the graph only ever carries the channel the
  guitar is on, and the point of this is to watch the ones it is not, which is
  what makes the wizard's "plug in and play" step an observation rather than a
  question. ⚠ `AudioDeviceManager` sums every callback after the first into the
  device's output and hands each an *uninitialised* scratch buffer, so the probe
  writing silence is an obligation, not an omission — dropping that clear would
  put whatever that memory last held on the speakers. Metering itself is gated
  on an atomic the wizard arms and drops (and `JuceEngine`'s boot disarms, since
  a reloaded page cannot un-arm what the previous one left set).
- `PluginManager` (`Source/plugins/`) — VST3-only `AudioPluginFormatManager` +
  `KnownPluginList` cached to disk; instantiation is async (message thread);
  scanning runs on a background thread with a crash blacklist
  (dead-man's-pedal file). `KnownPluginList` is internally locked, so the
  message thread can read it while a scan runs.
- `MainComponent` (`Source/app/`) — the standalone shell and the engine's
  `HostServices`: owns the device manager, `AudioProcessorPlayer`, the web
  view and the MIDI inputs, and the `PlectrifyEngine` that owns everything
  else (the rack, per-plugin editor windows, the audio-settings dialog is the
  shell's). Navigation is deferred until a window peer exists (WebView2
  requirement) — see `parentHierarchyChanged()`.

**A first launch chooses its own audio device.** With no `audio_settings.xml`,
JUCE's default is the OS's default, which on Windows is shared-mode WASAPI on
the built-in devices — a webcam microphone thirty milliseconds late. A guitarist
who hears that first has already decided what the app is. So
`chooseFirstRunAudioDevice` prefers ASIO where the machine offers it (falling
back the moment it fails to open — a listed driver is not an openable one, and
the wrong device beats no audio), takes the first block size lasting at least
5 ms rather than the smallest on offer (too large feels slightly slow and still
plays; too small crackles, and a rig that crackles reads as a broken app), and
switches on every input channel the interface has. Both rules are pure functions
in `Source/app/AudioSetupRules.h` with a CTest of their own, and the *same*
recommendation is reported over the bridge so the wizard's "recommended" mark
cannot drift from what the engine would have done. None of it ever runs against
an existing setup: that one is the user's, however odd it looks from here.

### First-run setup

**What the engine cannot choose, a wizard asks** (`ui/src/features/setup/`),
once, on the launch after a fresh installation. The audio device is the one
thing standing between installing Plectrify and hearing a guitar, and the native
`AudioDeviceSelectorComponent` asks all of it at once, in driver vocabulary, in
a grey OS dialog: driver family, device, channel mask, block size — four
questions answerable only by someone who already knows the answers. So the
wizard asks three, in the order a player can answer them, and the native dialog
stays for everything else (channel masks, exclusive modes, MIDI) under
Settings → **Advanced audio…**, with **Audio setup…** above it as the way back
into the wizard.

The step that earns the whole thing is the second one. *Which jack is your
guitar in?* is unanswerable by anyone — interfaces number their jacks from 1 and
their drivers from 0 — and getting it wrong is silence with nothing on screen to
explain it. So it is not asked: `InputProbe` meters every input channel, the
player strums, and `detectInputChannel` says which jack it heard. That rule is
pure and tested, and deliberately **not** "the loudest channel": something is
always loudest, and a detector that always has an opinion is one that
confidently selects the webcam microphone. A channel has to clear an absolute
floor *and* stand ×4 above the runner-up, and until both hold the honest answer
is none. It reads a **running maximum** per channel, not a live level — a strum
is one moment and the poll runs at 15 Hz — and the choice is committed the
instant it is made rather than on Next, so the rig comes alive under the
player's hands as the wizard says it heard them.

Three things keep it from being an obstacle. It is **skippable at every step**,
and skipping records the same `setupCompleted` that finishing does: a player who
waved it away must not meet it again next launch. It waits for
`engine.settingsReady()` before deciding it is owed at all — `subscribeAppSettings`
replays the *defaults* to a subscriber before `settings.json` has come back, and
the default of `setupCompleted` claims this machine is new, so acting on it
would greet every existing user with a welcome screen for half a second. (Same
reading as `starterInstallAttempted`: a stored settings object with no such
field belongs to a machine that has been played on.) And its bridge surface is
the ordinary shape — `subscribeAudioDevices` / `refreshAudioDevices` /
`setAudioDevice` as state plus a partial change, `watchInputLevels` /
`subscribeInputLevels` as an armed stream — with `MockEngine` implementing all
of it against a synthetic two-interface machine, so the wizard is buildable in
`pnpm dev` with no hardware at all.

`refreshAudioDevices(true)` re-enumerates the driver families, which on Windows
loads every installed ASIO driver in turn: slow, occasionally a vendor dialog,
and therefore what a Refresh button sends and never what an opening panel does.
`setAudioDevice` never answers with a result — the engine re-pushes what the
driver actually settled on, because a rate or block size the hardware refuses
comes back as the nearest one it took.

**Replacing a module** is its own engine operation, not a remove plus an
insert. A drawer tile dropped on a card rather than into a gap swaps the plugin
behind that module and keeps its place in the chain; `handleReplaceModule`
creates the replacement **first** and only then drops the old module, which is
what makes a failed plugin load leave the rack untouched, keeps any
`rackChanged` from ever describing a rack with a hole in it, and stops a lane
holding a single module from being emptied — `RackProcessor::removePlugin`
collapses an emptied lane, and with it a two-lane split. Inserting at the old
module's own index and removing it afterwards is also what makes the split
arithmetic cancel out, so no group moves. The replacement gets a **fresh
clientId**: knob mappings, name, colour and MIDI bindings name one plugin's
parameters and mean nothing against another's. The one exception is on the page
and never reaches here — dropping a patch on a module already hosting that same
plugin is a `loadPatch`, which keeps the module and everything bound to it.

**Swapping two modules** is the same gesture with a module in hand instead of a
tile: dragging a card onto another card trades their places, where dragging it
into a gap moves it. It is one engine operation too (`swapModules` →
`RackProcessor::swapSlots`), and a much cheaper one than replace — nothing is
created or destroyed, both modules keep their clientId and their plugin
instance, so every knob mapping, MIDI binding and scene value already pointing
at them follows for free. Deliberately not two moves: the pair of positions is
fixed, so each *place* keeps its own `laneId` and the flat array's lane tags
read the same afterwards as before. Every group's position — a count of the
serial modules preceding it — is therefore untouched, which is why a swap needs
no split arithmetic at all and works unchanged across a split boundary or
between two lanes; no lane can be emptied or born by one. The TS mirror is
`swapModulesInRack` in `rackMove.ts` — keep the two in step, as with
`moveModuleInRack`/`moveSlot`.

### Persistence (all under the per-user data root)

The per-user root is `%APPDATA%/Plectrify/` on Windows and
`~/Library/Application Support/Plectrify/` on macOS — one definition,
`plectrify::appDataDir()` in `Source/app/AppPaths.h`, which is also the web
page's file sandbox. The `%APPDATA%` shorthand below means that root on both
OSes.

- `rigs/` + `rigs/index.json` — saved full-chain rigs. TS owns the format,
  naming and listing; C++ only captures/applies plugin state (`captureRig` /
  `applyRig`) and provides sandboxed file I/O.
- `working-rack.json` — autosaved snapshot of the working rack (session
  restore). Standalone only: the VST3 build's working session rides the DAW
  project through the host-saved state (`writeSession`/`readSession`) instead
  of a global file two instances would fight over.
- `patches/<patchId>.patch` — one whole patch: its name, the plugin it was
  built for, the knob mapping, the module card's look (title override and
  accent colour — half of what gives a module its identity, so it travels with
  the mapping; absent means "leave the card alone", which is what a patch
  written before this or a pack's mapping-only one does), and the plugin's
  state (base64, captured via `captureModuleState`). Written TS-side via the engine's file I/O. **There is
  no index** — the list is built by reading the directory, and the file name is
  the patch's id, so a rename is one file rewritten and a delete leaves nothing
  behind. Unlike `rigs/`, which does keep an index: a rig is loaded whole and
  its plugin states are the engine's, not the page's. A patch whose file has
  no `state` loads its mapping alone. A patch saved here never carries assets —
  see *Installed patches* below for why that is a packaging job, not a saving
  one.

  Patches were called **presets** until they were renamed, and two older
  layouts are still migrated on first launch by `migrateLegacyPatches`: a
  `presets.json` index beside tone-only sidecars, then one whole
  `presets/<id>.preset` per patch. Both become `patches/<id>.patch` with the id
  intact, written before the original is deleted so an interrupted migration
  retries rather than losing the file. Those three legacy names are frozen in
  `patches.ts` — they name what is on users' disks, not what Plectrify writes, so
  a later rename must leave them alone.
- `settings.json` — app preferences (e.g. rack zoom).
- `audio_settings.xml` — last audio device state, which input channel the guitar
  is on, input/output gain and tuner state (`MainComponent`). **Its absence is
  what defines a first run for the audio stack** — see
  `chooseFirstRunAudioDevice` — just as `settings.json`'s absence does for the
  page (`setupCompleted`, `starterInstallAttempted`).
- `known_plugins.xml` — VST3 scan cache incl. the crash blacklist (`PluginManager`).
- `tone3000/credentials.json` + `state.json` — the connected TONE3000 account,
  and the browser window's size, position, monitor, page and scroll offset.
  **The one path `resolveAppFile` refuses to hand the web page**: everything else
  under this root is the page's own, and a bearer token is not. See *TONE3000*.

Outside the per-user root, under the machine-wide content root —
`%PROGRAMDATA%/Plectrify/` on Windows, `/Users/Shared/Plectrify/` on macOS
(`CatalogueInstaller::contentRootDirectory`) — with one exception: on macOS
the managed plugin directory is `~/Library/Audio/Plug-Ins/VST3` (the per-user
VST3 convention; machine-wide `/Library` is admin-owned there, which would
break the no-elevation install model), and the install markers live inside it
at `.plectrify-installed/`:

- `plugins/` — VST3s the user installed from the **Packages** panel
  (`CatalogueInstaller`), plus `.plectrify-installed/<id>.json` install markers
  and the verified `manifest.cache.json`.
- `<installDir>/` — content packages (e.g. `irs/`, `nam/`), unpacked as plain
  data and never loaded as code.
- `patches/` — installed **patches**. The one content folder the app reads
  itself, so it has rules of its own; see below.

### Installed patches

An installed patch is an ordinary `kind: "content"` package with
`installDir: "patches"`. Unlike IRs and captures — which are inert files some
plugin opens — patches are Plectrify's own format, so the app has to read them:

- **A read-only second root.** `readFile`/`listFiles` take an optional
  `root: "shared"` resolved by `MainComponent::resolveSharedFile` against
  `%PROGRAMDATA%/Plectrify/patches` alone. `writeFile` and `deleteFile` have no
  `root` parameter at all, so the page still cannot write outside `%APPDATA%`;
  scoping to `patches/` rather than the package root also keeps a read-only
  lister out of `plugins/`.
- **One patch is one folder**, named for its package id: `<id>/patch.json`
  beside an `assets/` folder. Every patch shares the one `patches/` directory,
  so that name is what keeps two apart — and package ids are unique across the
  catalogue by construction, so nothing has to invent a namespace. `listFiles`
  reports subdirectories separately from files (`dirs`), which is how
  `readPatchDir` finds them; the shared root *is* the patches folder, so its
  paths have no `patches/` part, and `patchPath` takes the root for exactly
  that reason.
- **A patch carries its own assets** — the capture or impulse response it
  loads — and this is the one reason installed patches are folders while the
  user's own stay single files. A plugin's state is opaque to Plectrify and bakes
  in the *absolute path* of whatever it loaded, which we can neither find nor
  rewrite. The only way a patch can be self-contained is for that path to be
  identical on every machine, which is exactly what a fixed
  `%PROGRAMDATA%/Plectrify/patches/<id>/assets/` (Windows) resp.
  `/Users/Shared/Plectrify/patches/<id>/assets/` (macOS) gives. It follows that
  authoring one means pointing the plugin at the *installed* copy and saving
  from there — there is no in-app "bundle this file", because saving cannot
  make a path machine-independent after the fact. It follows too that **those
  directory names are part of the format**: renaming either invalidates the
  state of every pack ever shipped for that OS, each of which must then be
  re-authored against the new path and republished. The preset→patch rename got
  away with a scripted byte substitution in the one existing pack only because
  the two words are the same length, so no length prefix inside the plugin's
  chunk moved. Do not count on that twice. And because the two roots differ,
  **a patch pack is inherently per-OS**: each platform is a source folder of
  its own, `packaging/content/<id>.windows-x64/` and `<id>.macos-arm64/`,
  separately authored against that platform's root and built into that
  platform's `assets` entry. Neither is the original — `host` refuses a patch
  in a bare `content/<id>/` folder rather than guessing which root it was
  saved against — and a patch package with no folder for a platform is simply
  not offered there. Content that bakes no paths (loose captures, IRs) is the
  OS-neutral shape, `content/<id>/`, whose one archive every platform's entry
  points at.
- **`preserveStructure: true` is what keeps the folder.** Content otherwise
  unpacks flat (`CatalogueInstaller`), which suits an IR browser but would tear
  a patch apart from its assets. It decides layout, never trust: the payload
  still lands under `installDir`, is still never loaded as code, and every
  archive entry still passes `isSafeArchiveEntryName`.
- **Shipped patches never enter the user's directory.** They are held in a
  separate field and merged only at the read boundary (`mergePatches`), because
  every mutating path works off the user's list alone. They carry `readOnly`,
  cannot be renamed, updated or deleted, and their rows offer nothing but the
  **Pack** badge. Making an editable one is the ordinary path — load the patch
  and save the module under a new name — so there is no separate duplicate
  action, and the copy is a fresh capture of the live module rather than a
  transcription of the shipped document.
- **A patch names the plugin it needs**, via `dependsOn` on its own entry —
  one package id, not a list — and never the other way round. Only that
  direction is true: a patch is a knob mapping plus one plugin's saved state,
  so it is meaningless without that plugin, while the plugin is complete with no
  patches at all. It follows that installing the patch installs the plugin
  first (`resolveInstallOrder`, expanded by `CatalogueInstaller` so every caller
  gets the same answer), installing the plugin brings no patches, and adding,
  revising or dropping a patch never touches the plugin's entry, its pin, its
  hash or its provenance. The id must name a package in the same catalogue, may
  not be the package's own, and may not complete a cycle — the app rejects the
  first two and terminates on the third, `validate` refuses to publish any of
  them. It must also reach every platform the package that needs it does, or the
  row advertises as installable somewhere its own dependency is not and the
  install fails by construction: `validate` refuses that catalogue, and a build
  handed one anyway greys the row exactly as a missing payload of its own would
  (`CatalogueInstaller::Item::available` spans the chain, not just the package).
  Nothing further is restricted, because the edge can only pull in a
  package the catalogue already offers on a row of its own, with its own `kind`,
  hash and destination: a dependency decides what is installed, never what any
  of it *is*.
- **Name the package for what it delivers, not for what it contains.**
  `amalgam-jtm45` / "JTM45", never `amalgam-patches`: a guitarist installs an
  amp, and the panel prints these verbatim. Same reasoning as `category`.

Build one with `pnpm --dir packaging host`, which is the single script for
**every** pack Plectrify's own author made — patches, NAM captures, and whatever
comes next. It is only ever for our own content: it checks each `.nam`'s
`modeled_by` against `--author`, because TONE3000's terms forbid redistributing
tones obtained there and the large GPL-labelled `.nam` collection relicenses
other people's captures wholesale. `host-content` and `host-plugin` remain
separate — they mirror a third party's files from a pinned upstream URL, which
is a different licensing question and a different set of gates.

Sources live in **`packaging/content/<packageId>/`**, checked into the repo, and
the whole folder ships. These packages have no upstream to mirror, so the repo
is where they live: a rebuild is then reproducible on any machine, and what is
published is under the same review as the catalogue entry pinning its hash.
Never build one out of `%APPDATA%`.

A folder holding a `patch.json` at its top level *is* a patch, and `host`
ships it wrapped in a folder named for the package id — so the repo layout is
`content/amalgam-jtm45.windows-x64/{patch.json,assets/}` (one such folder per
platform, since the saved tone bakes that platform's install path) and the
installed layout, on every OS, is `patches/amalgam-jtm45/{patch.json,assets/}`:
the suffix names which build a folder is, never what it installs as. Anything
else ships its own shape, flat, from a plain `content/<id>/`.

There is deliberately no per-type script and no flag saying what to build. The
catalogue entry already answers it: `include` says which files ship,
`installDir` says what kind of pack it is, and `licenseId` says under what
terms. Adding a new kind of authored content is a folder and an entry, not code.
And because the archive is reproducible (`pack.ts` stamps every staged file to a
fixed date before zipping), `host` can hash a fresh build against what the
catalogue already pins: a pack whose files have not changed is skipped, and one
that has changed gets its `version` and every platform's whole asset written
back **together** — the hand-paste this replaces was the easiest way to publish
a hash that did not match its bytes, and with two platforms it is also the
easiest way to leave one of them pinned to last week's archive.

That one zipper also records **Unix file types and modes**, which is what lets a
macOS bundle survive the round trip at all: the Mach-O under `Contents/MacOS` is
archived executable, and a framework's `Versions/Current` is archived as a link
rather than as a second copy of what it points at (archived as content, a
directory link fails outright and a file link is silently followed, breaking the
signature seal over both). `CatalogueInstaller` restores the execute bit on the
way out, because `juce::ZipFile` writes every entry 0644 and reads none of those
bits — an installed bundle whose binary lost `+x` is intact and unloadable.
Only an executable file or a link carries any of this, so a pack of plain data
files still zips to the same bytes on either machine and no published pin moves.

ProgramData rather than a profile folder, on Windows: these are ordinary VST3s
and IRs the user can point any other host at, so they want a shared,
conventional machine-wide path that every account can reach, and one that a
domain profile does not roam a few hundred megabytes through. `Users` may
create files and folders there by default, so no install needs elevation —
with the caveat that each account owns what it creates, so a second account
can add packages but not overwrite the first account's. Deliberately outside
`%APPDATA%` too — it is native executable payload, and `resolveAppFile`'s
sandbox, which the web page can read and delete within, must not reach it. The
uninstaller leaves the whole folder alone; these are the user's plugins.

macOS splits the two roles, because no stock location plays both. Plugins go
to `~/Library/Audio/Plug-Ins/VST3` — the per-user VST3 convention other hosts
already search; the machine-wide `/Library` is admin-owned, which would break
the no-elevation model. Content goes to `/Users/Shared/Plectrify/<installDir>` —
the one stock path that is both **identical on every machine** (a patch's
plugin state bakes its assets' absolute paths, so a per-user root would
produce packs that only work on their author's account) and user-writable
without elevation, with the same each-account-owns-what-it-creates semantics
ProgramData has — semantics the installer has to *establish* there rather than
inherit. ProgramData carries an ACL granting every account the right to add
something of its own; `/Users/Shared/Plectrify` would be created through the stock
umask as 0755, owned by whichever account installed first, and no second account
could add a package under it — or another patch beside an existing one — without
elevation. So `createSharedContentDirectory` gives each level of that root the
mode `/Users/Shared` itself carries, 1777: anyone may add, the sticky bit keeps
each account able to remove only what it owns, and files stay at the umask that
wrote them. Both roots stay outside the web page's sandbox. Trashing the app
leaves both alone, same promise as the Windows uninstaller.

That mac plugin directory is **not Plectrify's folder** — it is the user's, shared
with every other VST3 installer — so a marker recording that we once wrote
`Foo.vst3` is not on its own a licence to delete the `Foo.vst3` there now. Each
install therefore records an `installedFileFingerprint` (a hash of the bundle's
relative paths and sizes; no file contents, links recorded but never followed,
hidden entries skipped so a `.DS_Store` cannot disown a plugin), and both
destructive paths check it: an install refuses a name it does not account for
rather than clobbering a vendor's build (`another copy is already installed`),
and an uninstall whose fingerprint no longer matches drops the claim and leaves
the file. Plugins only — content markers record none, because on macOS the
content root is shared between accounts while these markers are per-user, and
fingerprinting there would make a second account's install refuse the first
account's files. Records written before fingerprints existed carry none and
behave as they always did, so this is additive on disk and needs no migration.

**Refusing an unclaimed name is a macOS rule, not a universal one.** Only that
directory is shared; the Windows one is `%PROGRAMDATA%\Plectrify\plugins`, a
folder of ours nothing else writes to, where a bundle no marker accounts for can
only be debris from an install of our own. Applying the mac rule there produced
a row that could never be installed again by any means the app offered — Retry
gave the same refusal forever and a restart showed it "not installed" while its
files sat in the load path. So the question "may this be replaced?" is
`mayReplaceManagedPlugin`, and `PluginManager::managedPluginDirectoryIsExclusive`
is the per-OS half of its answer: unclaimed is adoptable on Windows and refused
on macOS. A *claimed* name whose fingerprint has moved is refused on both — the
marker is still there to be removed if the user wants the name managed again.

**And the debris itself is the deeper bug, fixed on both.** A file and the record
of it cannot be written in one step, and quitting in between (the dev loop kills
Plectrify to relink, which is how this was first found) orphaned the file. The
marker is therefore written **twice**: a `MarkerState::pending` claim over the
names about to be written, carrying no version and no fingerprints, and the real
one after every bundle has moved. An empty version reads as not installed and
does not trip the skip-if-current check, while the claim is what makes an
interrupted attempt recoverable rather than permanent — on macOS too, where
adoption is not available. Names are checked against the guard **before** the
first is touched, so a package whose second bundle is somebody else's plugin
refuses outright instead of replacing the first and then failing.

### TONE3000

Amp captures and impulse responses from the TONE3000 community, downloaded from
inside the app and saved as **ordinary patches**. A downloaded tone is not a new
kind of object: it lands in `patches/<id>.patch` like any other, appears in the
module drawer and in a module's patch menu, and is recalled by a rig with no
extra machinery. `Source/tone3000/` is the native slice; `ui/src/features/tone3000/`
is what little of it is on the page.

**Browsing happens on TONE3000, in a window of its own.** There is no in-app
catalogue — no tabs, no filters, no tone grid, no model picker. The Browse
button opens `Tone3000BrowserWindow` straight onto TONE3000's own pages (their
sign-in, their search, their filters, their audition players), and the tone the
user picks there comes back through the OAuth callback and is downloaded,
chosen and applied without another question. This *replaced* an in-app panel
that mirrored a fraction of their catalogue behind bounded list endpoints; the
mirror could never be as good as the real thing, and the one thing it added —
a step in between — was the thing to remove. What is left on the page is the
button, the partnership splash, and a small status card while a capture
downloads.

**The window reopens where it was left** — size, position and monitor, in
`state.json`, checked against the displays attached *now*
(`Tone3000WindowState::place`, tested without a screen) so a window saved on a
monitor since unplugged is centred rather than opened off the desktop. Bounds
are read from the *peer* and polled once a second as well as taken from
`moved`/`resized`, because a natively-dragged title bar on Windows reached
neither hook, and the destructor sets `tearingDown` before anything else because
tearing the content down resizes the window and that resize was being saved as
a 128×128 stub.

**The window is hidden, not destroyed.** Closing it keeps the page alive, so
reopening in the same session is instant and nothing is reconstructed — the
list, the search that was typed, the scroll position, all still there. Only
signing out destroys it (its profile holds that account's cookie). The one case
that cannot be resumed is a *picked* tone: that spends the flow's
`authorization_id`, so `flowSpent` sends the next showing through a fresh
authorization, and then back to where the user was.

**A fresh authorization always means a fresh window** (`openBrowserWindow`, the
only place one is constructed). A web view that has already carried one answers
the next with a bare **"Error code: 9"** page, so `goTo` is for moving around
*inside* a flow and nothing else. Two paths used to break that rule and are the
two ways the window came back wrong: a hidden window whose page WebView2 had
discarded was re-navigated to a fresh authorize URL (so a reopening showed
either an empty frame or the error), and `restartFlow` traded TONE3000's honest
"your session has expired" for the same code. Both now rebuild — the second
deferred through `MessageManager::callAsync`, since it fires from inside the
window's own page-load callback and would otherwise delete the object still
executing. Anything reached with no page in the view is a rebuild, never a
reload.

**And that place is restorable, because their URLs carry it.** A Select URL is
`/api/v1/select/tones/<slug-id>?authorization_id=…` or
`/api/v1/select?creators=akka5&authorization_id=…`: path and filters, plus one
single-use parameter. So what is stored (plain, in `state.json`, beside the
bounds) is the URL **with `authorization_id` stripped** — a page, not a
credential — and on the next opening it is re-attached to the authorization the
fresh flow hands out (`Tone3000SelectUrl`, pure and tested). Saving the URL
whole is what produced their "your session has expired" page every time.
`/api/v1/session-expired` is still watched for by name and answered by
`restartFlow`, once per opening so an expiry loop cannot rebuild the window under
the user. Scroll rides along with the place: sampled once a second through
`evaluateJavascript` (the only thing Plectrify ever asks their pages — one
number and one address, and this window has no native bridge, so nothing can
come the other way), and re-applied on arrival until the lazily-loaded grid is
long enough to accept it.

**But the place is read out of the document, not off the navigations**, because
their catalogue is a single-page app: every filter, and opening a tone, changes
the route from inside the page, and `pageFinishedLoading` fires for none of it.
Watching navigations alone, the window's idea of where it was stayed
`/api/v1/select` for a whole session of browsing — which is the main route it
kept reopening on after a download. So `location.href` rides the same poll as
the offset (`onSeen`), and **a tone's own page is deliberately never
remembered** (`Tone3000SelectUrl::isTonePlace`): it is where every download is
started from, so remembering it would reopen the window on the tone the user
already has rather than on the list they picked it from. Leaving it
unremembered is also what preserves that list's offset across a pick, since an
offset is only ever saved for the page being remembered. The other half of that
is `beginChase`, which every fresh flow calls *before* the view is replaced: the
new one arrives blank and at the top, the poll does not wait for it to land, and
its honest "/" and "0" would otherwise be written over the very place and offset
being restored. The chase ends by arriving — and by every way of deciding not to
go anywhere, since one that nothing can end would silence those reports for the
life of the window.

**A tone with several models is not a question.** They are the same capture at
different weights, and someone holding a guitar should not be asked to choose:
`Tone3000Library::chooseModel` picks — the asked-for architecture first (the
other generation may not load at all), then `standard` size (`xl` ranks last;
this runs in the audio callback), then the lowest id so two merged API pages
cannot change the answer. A model the user picked on TONE3000's own page comes
back on the callback and is never second-guessed.

**All of it is native, and that is not an implementation detail.** The page runs
from a local origin, so every API call would be cross-origin at TONE3000's
discretion; its file sandbox is the per-user root, while downloads must land in
the machine-wide content root; and an OAuth bearer token has no business in a
document that also hosts third-party plugin UIs. So C++ owns the network, the
tokens and the files, and TypeScript keeps exactly what it already owned — the
patch document. The page never sees a token, a model URL or a byte of model data.

**The one hole in the page's sandbox.** `tone3000/credentials.json` sits under
the per-user root, and `MainComponent::resolveAppFile` **refuses any path whose
first segment is `tone3000`** — the only deny in that sandbox. Everything else
under the app data directory is the page's own to read, write and delete; a
bearer credential is not.

**How a tone gets into the plugin.** Neural Amp Modeler does not serialise its
model, it serialises the model's *absolute path* and reloads from it. So loading
a tone is: capture the module's live state, rewrite two strings, apply it back
(`NamStateCodec`). Starting from the live state is why swapping tones keeps the
player's own gain, EQ and noise gate. With no module on screen the plugin is
instantiated off the graph for its factory state, which is why no template blob
has to be shipped and kept in step with NAM's version.

`NamStateCodec` is the most delicate thing in the slice, and three details are
load-bearing: the state is wrapped in JUCE's binary-XML envelope *and* in
`MemoryBlock::toBase64Encoding`, which is **not** standard base64 (`<count>.<chars>`);
both length prefixes must be recomputed; and `getStateInformation` writes
`IComponent` **and** `IEditController`, applied in that order — so every element
carrying the marker is rewritten, or a stale path silently undoes the change.
It validates before it edits and returns `unsupportedLayout` rather than
producing a blob that would corrupt a plugin's state. **After bumping NAM, re-run
`ctest -R Plectrify.NamStateCodec` and load a tone by hand** (see step 7 of the
source-built-plugin procedure); `Tests/tone3000/NamStateProbe.cpp` drives the
real plugin and is deliberately not a CTest, because `ctest` must stay free of
third-party binaries.

**Downloads live at `<contentRoot>/tone3000/`**, named from ids alone —
`nam/<toneId>-<modelId>.nam`, `ir/<toneId>-<modelId>.wav`. The name is part of
the format: it is baked into every patch's plugin state, so a tone retitled
upstream must not move the file. It follows that a patch can be *repaired* on
another machine, or another operating system, by rewriting its paths to wherever
that machine keeps its downloads — something a shipped patch pack can never do.
This directory is deliberately **not** a package `installDir`: nothing in
`packaging/` may pick these files up. They are the user's own downloads under
TONE3000's terms, never Plectrify's to redistribute.

**`architecture` is single-valued, and omitting it is not "all".** TONE3000 then
applies its legacy A1 + Custom selection and *excludes* A2 — which is what current
NAM captures are. Omitting it makes modern packs report no loadable models and
makes TONE3000's own Select flow answer "not supported". `/models` therefore
fetches both selections and merges by id, and 2 is what the authorize URL and
`chooseModel` are given.

**Plectrify ships non-commercial, so search is off.** TONE3000's free tier permits
only the OAuth prompt flows and the bounded list endpoints — `favorited`,
`downloaded`, `created`, `trending`, `latest`. `/tones/search` is outside it, and
a key being technically able to reach it is not permission: their terms say
access may be revoked for an integration that does not follow the guidelines.
That is why `probeApiAccess` makes no request — the old version asked
`/tones/search?page_size=1` to find out whether it could search, which was itself
the thing it needed permission for, on every sign-in.

Since browsing moved to TONE3000's own window this costs nothing: the user
searches the whole catalogue over there, with their own account, and the only
API calls Plectrify makes are the tone and model lookups behind a download.
`Tone3000State.apiAccess` (`none` / `prompt` / `full`) now says whether the
account is usable at all rather than which parts of a panel to show. A
commercial integration must still be **reviewed and signed off by TONE3000
before public launch**.

**Attribution is an obligation.** Every TONE3000 patch stores its creator,
licence and tone URL, and renders them on the drawer tile and in the patch menu,
with the T3K mark linking to the tone's page. The provenance also rides on the
**module** (`RackModule.tone3000`, set by `loadPatch` and cleared when an
ordinary patch is loaded over it), which is what lets a card credit its tone
without looking up a patch that may since have been renamed or deleted — and
what **seals** it: a module playing a TONE3000 tone offers no knob-mapping
editing, because every tone here is the same plugin with the same six controls
in the same cells and the mapping arrives with the tone. The seal stops there —
the plugin's **own editor is offered like any other module's**. It was withheld
once, on the grounds that it is where a capture would be re-pointed by hand, but
it is also the only way to the rest of NAM (noise gate, the finer tone controls)
that the six mapped knobs do not reach, and re-pointing a capture is undone by
picking the tone again. Module-level editing — move, rename, colour, bypass,
patches — was never sealed either. A TONE3000
patch's drawer tile
shows the **tone's photograph** in place of the knob-layout preview every other
patch draws: they are all the same plugin with the same six knobs in the same
cells, so the layout distinguishes nothing, while the picture of the amp is what
someone is actually choosing between (it falls back to the knob grid if the
image will not load). The record is built natively
(`describeProvenance`) because the page never sees a tone — its field names and
the patch document's are one contract, written in one place. Logo discipline is
theirs: the full TONE3000 wordmark at entry points (splash, drawer tile), the
compact T3K mark only afterwards, never both in one view.

**Configuration** lives in `CMakeLists.txt` as cache variables, mirroring
`PLECTRIFY_CATALOGUE_URL`: `PLECTRIFY_TONE3000_CLIENT_ID` (the *publishable*
key — it is meant to be embedded, authorises nothing on its own, and PKCE is what
proves a code may be redeemed), `PLECTRIFY_TONE3000_API`, and a redirect URI that
differs per configuration (`localhost` in Debug, `https://plectrify.com/oauth/tone3000`
in Release, prerendered in `site/`). The `t3k_cs_` **secret key is a server-side
credential Plectrify has no use for and must never carry** — every request is made
as the signed-in user, with their token, against their own rate limit.


## Code style

- **C++**: JUCE conventions — `juce::` prefixes, `#include <JuceHeader.h>`,
  `#pragma once`, Allman braces, 4-space indent, `JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR`
  in classes. Headers carry a doc comment explaining the class's role and
  threading rules; match that density. Cross-slice includes are bare
  (`#include "RackProcessor.h"`) — the slice folders are on the include path;
  don't add relative `../` paths.
- **TypeScript/Svelte**: Svelte 5 runes (`$state`, `$derived`, `$props`,
  `$effect`), strict TS (`verbatimModuleSyntax`, `isolatedModules` — use
  `import type` for types), Tailwind utility classes for styling, interfaces
  documented with JSDoc-style comments. Features are plain callback props, not
  global stores.
- **Formatting**: don't hand-format UI files. Run `pnpm format` in `ui/`;
  Prettier formats Svelte/TypeScript/CSS at 100 columns and the Tailwind plugin
  applies the canonical utility-class order.
- Both sides use "vertical slices" (feature folders), not layer-based
  grouping — keep new code in the matching slice.

## Testing

- **Native**: two console-app CTest targets under `Tests/` —
  `Plectrify.TunerDetector` (tuner DSP on synthetic tones),
  `Plectrify.NamStateCodec` / `Plectrify.Tone3000Auth` / `Plectrify.Tone3000Library`
  (the TONE3000 slice's pure rules — state rewriting, PKCE, download paths,
  which model gets picked, where the browser window reopens) and
  `Plectrify.RackProcessor` (headless graph topology: slot order, connection
  rebuilding, split-position arithmetic, using dummy in-memory plugins).
  Build the targets (`PlectrifyTests`, `PlectrifyRackTests`) then run
  `ctest --test-dir build -C Debug --output-on-failure` (ctest sits beside the
  VS-bundled cmake). `pnpm app --dist` and both release scripts run these
  automatically.
- **UI**: `pnpm format:check` (Prettier + Tailwind class order), `pnpm check`
  (svelte-check), and `pnpm test` (vitest over the pure engine modules). All
  three run in `pnpm app --dist` and both release scripts. Note vitest does
  not type-check — that's what `pnpm check` is for; keep all three green.
- **Packaging**: `pnpm --dir packaging test` (node:test) covers the
  reproducible archiver's determinism contract; `pnpm --dir packaging check`
  type-checks the tooling, including the mac build/host scripts.
- Manual: run the app (`pnpm app`); UI behaviour can be exercised standalone
  in the browser via `pnpm dev` against `MockEngine`.

## Security and environment notes

- Never commit `third_party/` (fetched dependency payloads), `build*/`,
  `ui/dist/`, or any `node_modules/` — all are gitignored.
- The app loads and executes third-party VST3 binaries in-process; plugin
  scanning is user-triggered and cached, not automatic. The macOS build keeps
  that possible under the hardened runtime via the
  `com.apple.security.cs.disable-library-validation` entitlement
  (`cmake/Plectrify.entitlements`), paired with `audio-input`; the signed
  catalogue manifest stays the trust root for what gets installed.
- User data lives under the per-user root (`%APPDATA%/Plectrify/` /
  `~/Library/Application Support/Plectrify/`); don't write outside it.
