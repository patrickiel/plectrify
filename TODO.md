# VST3 plugin — remaining work

Core support landed (engine extraction, `PlectrifyPlugin` VST3 target,
host-saved state, UI capability gating, `pnpm app --plugin`). This is what is
left, in the order it matters. Delete items as they land; delete the file when
it is empty.

## Verify (before trusting the build)

- [ ] `pnpm app --clean` once on any tree that had pre-extraction objects —
      the header changes can trip the stale-object hazard AGENTS.md documents
      (that was the one crash during development; a clean build fixed it).
- [ ] DAW checklist (Reaper or Live, Windows):
  - [ ] Load on a guitar track (mono and stereo), dry passthrough on an empty
        rack, build a rack from the drawer.
  - [ ] Open a hosted plugin's own editor; close/reopen the Plectrify editor —
        rack, mappings, names, colours return (`readSession` adoption).
  - [ ] Save the DAW project, quit, reload — whole rig restores with tones
        (host-saved state).
  - [ ] Two instances with different racks.
  - [ ] Offline render produces processed audio.
  - [ ] MIDI-learn a CC from a DAW MIDI track.
  - [ ] PDC null test with a latency-reporting plugin in the rack
        (`setLatencySamples` is net-new).
  - [ ] Rig round-trip: saved in the standalone, loaded in the plugin, and
        back.
- [ ] One standalone manual pass (rigs, catalogue install, TONE3000 download,
      standby engage/wake, setup wizard, window resize/theme) — the extraction
      was verbatim and all gates are green, but nobody has clicked through
      since.
- [x] macOS: build + smoke `pnpm app --plugin` on the Mac (artefact path
      fixed — JUCE appends `$<CONFIG>` under single-config generators too;
      pluginval strictness 5 passes on Debug and on the staged Release
      bundle, which also found the hidden-editor host-kind bug the
      initialisation-data commit fixes).
  - [x] Verified in Ableton Live on the Mac: the installed Release plugin
        loads and plays. The finer checklist items (project save/reload, two
        instances, offline render, MIDI learn, PDC null test) had their full
        pass on Windows; spot-check them on the Mac as they come up in use.

## Release plumbing

- [x] Windows installer: `[Tasks]` checkbox (checked by default) installing
      `Plectrify.vst3` to `{commoncf64}\VST3`, self-contained (ui + NAM in
      `Contents/Resources`); `[InstallDelete]`/`[UninstallDelete]` replace or
      remove the bundle on every run so a version-skewed app/plugin pair is
      unrepresentable; `release.windows.ts` builds `PlectrifyPlugin_VST3`,
      gates on its DLL + PDB, stages the bundle, archives the plugin PDB
      beside the installer.
  - [ ] Rehearse `pnpm release` after committing (dirty-tree gate), then run
        the built setup.exe: default install puts the plugin in Common Files
        and a DAW loads the **Release** build (first exercise of the
        no-fallback resource path); task-unchecked rerun removes it;
        uninstall removes it and leaves user data.
- [x] macOS release: `release.macos.ts` builds `PlectrifyPlugin_VST3`, gates
      on its Mach-O, stages UI+NAM into `Contents/Resources`, seals the
      `.vst3` with its own hardened-runtime signature (explicit entitlements —
      Ninja never applies the CMake `HARDENED_RUNTIME_OPTIONS`), and packages
      one installer pkg that always installs both builds (a DMG's drag target
      for `/Library/Audio/Plug-Ins/VST3` dangles on a Mac that never had a
      VST3 installed; `customize="never"` makes version skew unrepresentable).
      Rehearsed with `--ad-hoc --no-upload`; payload layout, bundle seals and
      self-containment verified, pluginval passes on the staged bundle.
  - [ ] Notarization is deliberately deferred, not pending: mac releases ship
        with `pnpm release --ad-hoc` until the project earns the Apple
        Developer membership (99 USD/year, no open-source exemption). The
        cost is the pkg's one-time Open Anyway and the per-update microphone
        re-prompt, both documented on the site. When bought: both Developer
        ID certificates (Application + Installer) into the keychain, a
        notarytool profile, drop `--ad-hoc` — the whole flow is already
        wired and probed for.
  - [x] Ran the built pkg on a Mac with no `/Library/Audio/Plug-Ins/VST3`:
        both destinations landed, Installer created the folder, the installed
        standalone runs, and Ableton Live loads and plays the installed
        Release plugin (the no-fallback resource path, exercised for real).
- [x] Licensing notices: `## Steinberg VST3 SDK` section in
      `THIRD_PARTY_NOTICES.md` electing GPLv3 (ASIO-notice pattern, VST
      trademark line included); both SOURCE_OFFER texts updated; the
      corresponding-source archive already covers `Source/plugin/` (git
      archive HEAD).
  - [x] Steinberg registration: none exists anymore. The VST3 SDK went MIT
        in October 2025 — no agreement, no fee, and their portal calls the
        usage guidelines "best practice, but optional"; even the old dual
        licence never required registration on the GPLv3 path Plectrify
        elected. The notices keep that GPLv3 election because JUCE 8.0.14
        bundles a pre-relicensing SDK copy whose headers still say so;
        simplify them to MIT when a JUCE bump brings the MIT-licensed SDK.
        "VST" stays a Steinberg trademark — the attribution line already in
        THIRD_PARTY_NOTICES.md covers it, and the VST-compatible logo (the
        one thing that was ever tied to signed paperwork) is not used.

## Later

- [ ] Out-of-process plugin scanning — Rescan inside a DAW still loads plugins
      in-process, so a crashing plugin takes the host down. Until then: scan in
      the standalone, let the plugin read the shared cache. Cheap interim: a
      plugin-mode warning line on the Rescan affordance.
- [ ] Host-exposed automation parameters (the plugin currently exposes none).
- [x] AU format for Logic users: `FORMATS VST3 AU` on macOS, registered
      `aufx` (not JUCE's `aumf` default — Logic files MIDI-controlled effects
      outside the Audio FX menu; the trade is that Logic sends no MIDI, so
      MIDI learn is VST3-hosts-only). Dev loop installs it to
      `~/Library/Audio/Plug-Ins/Components`; the pkg gets a third component
      into `/Library/Audio/Plug-Ins/Components`. auval passes (one expected
      aufx/MIDI pairing warning); pluginval strictness 5 passes.
  - [ ] Smoke it in Logic or GarageBand once (neither is installed here).
- [ ] Host-tempo sync for looper/metronome (`AudioPlayHead`).
- [ ] Cross-process locking for `known_plugins.xml` (currently atomic write,
      last-writer-wins).
- [ ] Looper preallocates ~46 MB per instance — revisit if multi-instance
      memory becomes a complaint.
- [ ] Feedback-guard slideout copy: note it is tuned for a live guitar input —
      sustained steady program material in a DAW can false-trip it (defaults
      off either way).
- [ ] macOS debug symbols: the Release build emits no dSYM for the app or the
      plugin (no symbolication equivalent of the archived Windows PDBs) —
      add `-g` + dsymutil to the Release build and archive the dSYMs beside
      the pkg if a mac crash ever needs mapping.

## Housekeeping

- [ ] Commit the VST3 work (nothing is committed yet; the working tree also
      holds the earlier `packaging/` patch-pack changes — separate commits).
