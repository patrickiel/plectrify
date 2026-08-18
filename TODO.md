# VST3 plugin — remaining work

Core support landed (engine extraction, `PlectrifyPlugin` VST3 target,
host-saved state, UI capability gating, `pnpm app --plugin`). This is what is
left, in the order it matters. Delete items as they land; delete the file when
it is empty.

## Later

- [ ] Out-of-process plugin scanning — Rescan inside a DAW still loads plugins
      in-process, so a crashing plugin takes the host down. Until then: scan in
      the standalone, let the plugin read the shared cache. Cheap interim: a
      plugin-mode warning line on the Rescan affordance.
- [ ] Host-exposed automation parameters (the plugin currently exposes none).
- [ ] Host-tempo sync for looper/metronome (`AudioPlayHead`) — the precondition
      for ever offering either in a DAW again, since both are now declined
      there (`HostCapabilities`) precisely because they cannot follow the
      project tempo. The *hosted* plugins already get the host's playhead:
      `PlectrifyAudioProcessor` forwards it to the graph, which hands it to
      every node.
- [ ] MIDI needs an open editor in a plugin. The bindings are dispatched by the
      page (`Rack.svelte`, `StatusBar.svelte`, `MidiLearn.svelte`), and the page
      dies with the editor, so a footswitch stops working when a DAW closes the
      window — the one live control there, since no automation parameters are
      exposed either (above). The FIFO no longer backs up (`onEngineTick` now
      drains above the view guard), so nothing replays on reopen; making it
      *work* headlessly means pushing the binding table to C++ and dispatching
      there.
- [ ] Cross-process locking for `known_plugins.xml` (currently atomic write,
      last-writer-wins) — and with it the scan pedal, which is worse than
      last-writer-wins. `scan_in_progress.txt` sits in the shared root while
      `PluginManager` is a per-engine member, so on a machine with no cache yet,
      a second engine reads the first's *live* pedal as a previous crash,
      blacklists the bundled NAM into the shared cache, and deletes the pedal
      the first scan is still relying on. Wants owner-specific pedal/temp paths
      or a real interprocess lock; the page's own writes were given per-engine
      temp names for the same reason (`PlectrifyEngine::handleWriteFile`).
- [ ] `getTailLengthSeconds()` returns 0, so a host using it for bounce/freeze
      padding can truncate a delay or reverb tail. `AudioProcessorGraph` returns
      0 too, so there is nothing to delegate to — it needs a real per-path
      aggregation over the rack's nodes.
- [ ] The starter-install gate re-reads `settings.json` immediately before
      deciding, which closes the hours-long window where two instances both
      saw `starterInstallAttempted: false`. Two pages booting within the same
      few milliseconds can still both decide to install; a durable answer wants
      the decision made once in C++ rather than per page.
- [ ] macOS debug symbols: the Release build emits no dSYM for the app or the
      plugin (no symbolication equivalent of the archived Windows PDBs) —
      add `-g` + dsymutil to the Release build and archive the dSYMs beside
      the pkg if a mac crash ever needs mapping.
