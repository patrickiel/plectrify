# Plugin build review

The new plugin build loses core DAW behavior when its editor is closed, fails to forward essential host context, and introduces multi-instance races over shared state. It also duplicates large plugin-state blobs and has several persistence and rendering correctness gaps.

## P1 - Keep host MIDI active without an editor

Location: [`Source/app/PlectrifyEngine.cpp:1141`](Source/app/PlectrifyEngine.cpp#L1141)

When a DAW closes the editor during playback, `webView` becomes null and this return occurs before `host.onEngineTick()`. Host MIDI is converted into rig/scene actions only by the Svelte page, so those controls stop working headlessly; the FIFO also accumulates presses that may replay when the editor reopens.

Keep the MIDI bindings and dispatcher outside the ephemeral editor or otherwise process them while detached.

## P1 - Forward the DAW playhead into the graph

Location: [`Source/plugin/PluginProcessor.cpp:116`](Source/plugin/PluginProcessor.cpp#L116)

For tempo-synced delays, modulation, and transport-aware hosted plugins, the DAW sets the playhead on the outer `PlectrifyAudioProcessor`, but the separate `AudioProcessorGraph` never receives it. `AudioProcessorGraph::processBlock` forwards its own playhead to its nodes, so they currently see null and cannot follow host tempo or position.

Set the graph's playhead from the outer processor before processing.

## P1 - Coordinate the shared store across plugin instances

Location: [`Source/plugin/PluginEditor.cpp:15`](Source/plugin/PluginEditor.cpp#L15)

Each open plugin editor creates an independent page and `JuceEngine`, while all of them rewrite the same settings and library indexes under the shared root. If two editors are open, saving rig A in one and rig B in the other can make the second stale `rigEntries` snapshot overwrite the index and orphan A. On a fresh profile, both pages can also pass the starter-install check and launch competing installs.

Add cross-instance synchronization or merge-on-write, as required by [`AGENTS.md:14`](AGENTS.md#L14) and [`AGENTS.md:268`](AGENTS.md#L268).

## P1 - Store only metadata in the plugin session blob

Location: [`ui/src/lib/engine/JuceEngine.ts:3497`](ui/src/lib/engine/JuceEngine.ts#L3497)

In plugin mode, this sends the result of `captureStoredRack()`, whose `StoredModule` includes every plugin's base64 state, into `sessionBlob`. `buildHostStateJson()` then independently captures the same states again in `entries`.

With NAM captures measuring megabytes, every session autosave crosses the bridge with redundant data and the DAW project stores roughly two copies of the rack, causing large projects and autosave stalls.

Serialize only the page-owned metadata for the plugin session.

## P2 - Report the hosted rack's tail

Location: [`Source/plugin/PluginProcessor.h:50`](Source/plugin/PluginProcessor.h#L50)

When the rack contains a delay or reverb, returning zero tells the DAW that processing can stop immediately after the input ends. Hosts that use this value for offline bounce, freeze, or playback-stop rendering can therefore truncate the effect decay.

Compute an aggregate tail from the hosted topology and notify the host when it changes.

## P2 - Serialize bundled scans across processor instances

Location: [`Source/app/PlectrifyEngine.cpp:103`](Source/app/PlectrifyEngine.cpp#L103)

On a fresh cache, every simultaneously created processor reaches this startup scan with its own `PluginManager`, but all managers use the same `scan_in_progress.txt` under the shared data root. A second scan can interpret the first scan's live dead-man pedal as a previous crash and blacklist the bundled NAM plugin; the fixed temporary cache filenames can race as well.

Use an interprocess or process-wide scan lock, or owner-specific pedal files, as required by [`AGENTS.md:14`](AGENTS.md#L14).

## P2 - Propagate non-realtime rendering to the graph

Location: [`Source/plugin/PluginProcessor.cpp:46`](Source/plugin/PluginProcessor.cpp#L46)

During a DAW offline bounce, JUCE sets non-realtime mode only on the outer processor. Because that mode is never forwarded to `graph`, its hosted plugins remain in realtime mode and `AudioProcessorGraph` does not use its offline wait behavior for pending render sequences, potentially changing quality or producing incomplete initial blocks.

Forward `setNonRealtime` transitions to the graph.

## P2 - Mark editor-size changes dirty

Location: [`Source/plugin/PluginEditor.cpp:38`](Source/plugin/PluginEditor.cpp#L38)

After the host-state cache has been captured, resizing only updates these fields and never marks the state dirty or calls `updateHostDisplay`. An off-message-thread `getStateInformation` therefore continues returning the old cached dimensions indefinitely when no other edit occurs, despite editor size being documented as host-persisted.

Mark the engine state dirty when the remembered size changes.

## P2 - Leave the standalone restore sentinel to its owner

Location: [`Source/app/PlectrifyEngine.cpp:166`](Source/app/PlectrifyEngine.cpp#L166)

Every plugin processor destruction now runs this cleanup against the shared app-data directory. If the standalone is concurrently restoring its working rack and a DAW removes or shuts down a Plectrify instance, the plugin deletes the standalone's crash sentinel. A subsequent standalone crash then retries the suspect rack instead of quarantining it.

Gate this deletion to the standalone host or make the marker owner-specific, as required by [`AGENTS.md:14`](AGENTS.md#L14).
