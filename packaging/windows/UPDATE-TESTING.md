# Testing the in-app update on Windows

How to exercise the self-update path by hand (AGENTS.md → *Updating*). The
engine only ever installs a version **newer** than the one running, so every
recipe below either runs the installer the way the app would, or makes a Debug
app believe it is old.

## 1. The shipped installer path

The Preview workflow builds `Plectrify-win-x64-setup.exe` from the branch
(Actions → Preview → the run for the PR → the `plectrify-windows-x64-…`
artifact). With Plectrify running, start it the way the app does:

```powershell
.\Plectrify-win-x64-setup.exe /SILENT /NORESTART /NOCANCEL /NOCLOSEAPPLICATIONS /PLECTRIFYRELAUNCH=1 /LOG="$env:TEMP\plectrify-update.log"
```

Expected:

- the UAC prompt, then nothing visible until you close Plectrify — Setup is
  waiting on the app's single-instance mutex (up to a minute, then it says so
  and stops);
- the progress window, with the WebView2 step skipped when the runtime is
  already installed (the log says which `[Run]` entries ran);
- Plectrify reopens from Program Files, **not elevated** (Task Manager's
  Details tab, *Elevated* column).

The same exe with no parameters is the ordinary interactive install and must
look exactly as before.

## 2. The in-app flow, end to end

A local folder stands in for the GitHub release. A Debug build honours
`PLECTRIFY_UPDATE_BASE_URL` for exactly this; a shipped build has no such
override.

```powershell
# a) a folder holding the installer and a manifest naming it
mkdir $env:TEMP\plectrify-update-test; cd $env:TEMP\plectrify-update-test
# copy Plectrify-win-x64-setup.exe from the Preview artifact here, then:
$hash = (Get-FileHash .\Plectrify-win-x64-setup.exe -Algorithm SHA256).Hash.ToLower()
"{ ""version"": ""0.1.9"", ""platform"": ""windows-x64"", ""installer"": ""Plectrify-win-x64-setup.exe"", ""sha256"": ""$hash"" }" | Set-Content -Encoding ascii release-manifest.json
npx serve -l 8765 .          # any static server that sends Content-Length

# b) in the repo, in another terminal: an "old" Debug app pointed at the folder
Set-Content VERSION 0.1.0
$env:PLECTRIFY_UPDATE_BASE_URL = 'http://127.0.0.1:8765/'
pnpm app
```

The manifest's `version` must be above `VERSION`; the installer's own
`AppVersion` does not matter. Expected in the app:

1. The start-up notice says a newer Plectrify is available (the GitHub API's
   answer), and the About panel shows an *Install* row.
2. **Install update** → progress bar ("Downloading 12 of 37 MB…") →
   "Verifying the download…" → "Waiting for Windows to allow the installer…"
   → the UAC prompt → "Installing… Plectrify will close and reopen in a
   moment." → the app closes → Setup's progress window → Plectrify reopens
   from Program Files, not elevated.
3. `%TEMP%\Plectrify\updates` is empty again (the new launch clears it).

Afterwards: `git checkout -- VERSION`, rebuild, and reinstall the official
release over the test build if you want Program Files back as it was.

Variants worth one run each:

- **Decline the UAC prompt.** The notice returns to the plain offer — not an
  error — and the app keeps running.
- **Leave the UAC prompt alone.** Windows cancels it after about two minutes;
  same outcome as declining.
- **Cancel mid-download.** Leave `VERSION` at 0.1.0 but skip the env var: the
  app then fetches the real latest installer from GitHub, which takes long
  enough to press *Cancel*. The `.part` file goes and the offer returns.
  Letting it finish installs that release silently; if it predates the
  installer-side handshake it cannot relaunch, and the notice reports the
  launch failure with the browser download beside it.
- **A DAW holding the plugin.** Open a DAW with Plectrify.vst3 on a track, then
  click Install: refused with the "close that app" sentence.
- **A page reload mid-download** (`pnpm app` with HMR, save any UI file while
  the bar moves): the bar comes back where it was.

## 3. Building the installer locally instead of fetching the artifact

Only needed when the Preview build is not an option. It takes Inno Setup 6
(`winget install JRSoftware.InnoSetup`), a Release build of the app
(`pnpm app --dist --config Release --no-run`) and of the plugin
(`cmake --build build --config Release --target PlectrifyPlugin_VST3`, with the
VS-bundled cmake), the two redistributables from
`packaging/windows/dependencies.json`, and a stage folder laid out as
`scripts/release.windows.ts` lays it out: `Plectrify.exe`, `ui/` (a copy of
`ui/dist`), `plugins/` (the bundled NAM from `third_party/plugins`),
`vst3/Plectrify.vst3/` with its own `Contents/Resources/{ui,plugins}`, and
`LICENSE`, `JUCE_LICENSE.md`, `THIRD_PARTY_NOTICES.md`, `SOURCE_OFFER.txt`,
`BUILD_INFO.txt` (the last two can be placeholders). Then:

```powershell
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" /DAppVersion=0.1.9 /DStageDir=<stage> /DOutputDir=<out> `
  /DWebView2Installer=<path>\MicrosoftEdgeWebView2RuntimeInstallerX64.exe /DVCRedistInstaller=<path>\VC_redist.x64.exe `
  packaging\windows\Plectrify.iss
```

The result goes into the folder of step 2. From Git Bash, prefix the ISCC call
with `MSYS2_ARG_CONV_EXCL="*"` or the `/D…` flags are rewritten as paths.

## What the browser mock covers

`pnpm dev` reports the version `dev`, which never parses as a version, so the
notice and the About row do not appear there and `MockEngine`'s simulated run
is not reachable from the UI. The mock's `installUpdate` can be driven from
the console (`window` has no handle on the engine; call it from a component
during development) — or give the mock a parseable version such as `0.0.1`
for the session, at the cost of the notice showing until dismissed.
