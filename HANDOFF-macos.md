# Prompt: continue the VST3 plugin work on macOS

Paste everything below this line into Claude Code on the MacBook, from the
repo root, on the `vst` branch. (The branch is local to the Windows machine
and deliberately unpushed — get it here yourself first, e.g. push it when you
choose to, or transfer the repo.) Delete this file when the mac work is done.

---

Continue Plectrify's VST3 plugin work on macOS. The Windows side is done and
committed on this branch (`vst`, two commits: "Add a VST3 plugin build: one
engine, two hosts" and "Ship the VST3 in the Windows installer behind a
default-on task"). Read AGENTS.md first — the "One engine, two hosts" section
under Architecture documents everything that landed; TODO.md tracks what is
left. Do not push any branch or tag, ever; I publish myself.

## What already exists (built and verified on Windows, compiled-untested here)

- `PlectrifyEngine` + `plectrify::HostServices` (Source/app/) — the engine
  extracted from MainComponent; `Source/plugin/` — the VST3 processor/editor.
- CMake target `PlectrifyPlugin` (build target `PlectrifyPlugin_VST3`),
  configured by the same `plectrify_configure_target()` as the app.
- `pnpm app --plugin` in scripts/run.macos.ts — builds the Debug VST3 and
  installs it to `~/Library/Audio/Plug-Ins/VST3` via ditto; written blind on
  Windows. Artefact path verified and corrected: JUCE appends a `$<CONFIG>`
  segment even under single-config generators, so the bundle lands at
  `build-macos-debug/PlectrifyPlugin_artefacts/Debug/VST3/Plectrify.vst3`.
- `moduleResourceDir()` (Source/app/AppPaths.h) resolves resources inside a
  `.vst3` on mac via `currentApplicationFile` → `Contents/Resources`; a Debug
  build needs no staging (source-tree fallbacks).
- The mac SOURCE_OFFER text in scripts/release.macos.ts already mentions the
  VST3 SDK GPLv3 election; the mac release *pipeline* is untouched.

## Task 1 — build + smoke (do this first)

1. `pnpm install` at the root if fresh; `pnpm app --clean --no-run` once —
   the extraction changed headers massively, and a stale-object build is the
   known hazard here (it produced one startup crash on Windows; a clean build
   fixed it with zero code changes).
2. Run the standalone (`pnpm app`) and click through briefly: rack edits, a
   rig load, the setup wizard from Settings — the shell/engine split must not
   have changed mac behavior (native title bar, WindowResizeDriver path).
3. `pnpm app --plugin`, fix whatever the untested mac path gets wrong, then
   the DAW checklist in a VST3 host (Reaper/Live — Logic is AU-only, out of
   scope): load on a mono and a stereo track, dry passthrough on an empty
   rack, build a rack, close/reopen the editor (state returns), save/reload
   the DAW project (whole rig returns), two instances, offline render, MIDI
   learn from a track, standalone↔plugin rig round-trip.

## Task 2 — macOS release plumbing (mirror of the Windows work)

Read the "Ship the VST3 in the Windows installer" commit and
scripts/release.windows.ts (staging block + gates) as the model, then extend
scripts/release.macos.ts:

- Build `PlectrifyPlugin_VST3` for Release; gate on the bundle's Mach-O and
  its dSYM/PDB-equivalent as the script gates the app.
- Stage into the bundle **before signing**: `ui/dist` →
  `Plectrify.vst3/Contents/Resources/ui`, and `stageBundledPlugins` →
  `Contents/Resources/plugins` — the same self-contained rule as Windows (a
  Release binary has no source-tree fallback), and on mac the staging must
  precede codesign because the tree is part of the seal. Note the existing
  script codesigns each staged NAM bundle individually before the outer seal
  (release.macos.ts ~:310-356) — the plugin bundle needs the same treatment:
  sign the staged NAM inside it, then the `.vst3` itself with `signArgs()`
  (hardened runtime + entitlements as CMakeLists' plugin args declare),
  before/independent of the app's seal.
- Decide placement: ship the `.vst3` in the DMG beside the app with a symlink
  to `~/Library/Audio/Plug-Ins/VST3` (no elevation, matches the drag-install
  model) — or a small install step. Prefer the symlink; document the choice.
- Notarize what the DMG carries (the existing notarytool flow covers the DMG
  whole; confirm the `.vst3` inside passes stapler/spctl expectations).
- Keep both SOURCE_OFFER texts in step (AGENTS.md rule): once the DMG carries
  the plugin, the mac text's "covers Plectrify itself" paragraph should name
  the two builds the way scripts/release.windows.ts's now does.
- Check off TODO.md's macOS release item when verified.

## Constraints

- pnpm, never npm. No Claude attribution in commits. Never push branches or
  tags — publishing is mine.
- Follow AGENTS.md conventions (comment voice, vertical slices). Run the full
  gate (`pnpm app --dist --no-run`) before calling anything done; the release
  script requires a clean tree, so commit before rehearsing `pnpm release`
  (which, without `--pre-release`, builds and packages locally and publishes
  nothing — never run it with `--pre-release`).
