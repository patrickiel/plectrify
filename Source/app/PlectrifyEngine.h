#pragma once

#include <JuceHeader.h>
#include "CatalogueInstaller.h"
#include "HostServices.h"
#include "LooperSessionStore.h"
#include "PluginEditorWindow.h"
#include "PluginManager.h"
#include "RackProcessor.h"
#include "StandbyController.h"
#include "Tone3000Service.h"

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

/**
    Everything of Plectrify that is the same whether it runs standalone or as a
    VST3 plugin: the rack graph, the plugin library and catalogue, the TONE3000
    slice, rig capture/apply, Auto Standby's policy hookup, the sandboxed file
    I/O — and both directions of the event-only bridge to the Svelte UI.

    Deliberately not a juce::Component. A plugin editor is created and
    destroyed freely while audio keeps running, so the engine outlives any
    view: the host constructs its web view from registerEventListeners()'d
    options and attaches it (attachWebView / detachWebView); every C++ -> JS
    push funnels through emit(), which quietly drops events while no view is
    attached — a state the page's request/re-push contract already recovers
    from.

    Host-shaped questions — the audio device, MIDI inputs, the window — go
    through HostServices (see HostServices.h). Everything runs on the message
    thread; the two listener callbacks that plugins may fire from the audio
    thread only flip atomics.
*/
class PlectrifyEngine : private juce::Timer,
                        private juce::AudioProcessorListener
{
public:
    explicit PlectrifyEngine (plectrify::HostServices& host);
    ~PlectrifyEngine() override;

    RackProcessor& getRack() noexcept { return rack; }

    /** Chains the engine's ~60 withEventListener registrations onto `options`
        (JS -> C++ half of the bridge). Call once, before constructing the web
        view from the result. */
    juce::WebBrowserComponent::Options registerEventListeners (juce::WebBrowserComponent::Options options);

    /** The view emit() pushes into. Non-owning: the host keeps ownership and
        must detach before destroying the view. */
    void attachWebView (juce::WebBrowserComponent* view) noexcept { webView = view; }
    void detachWebView() noexcept { webView = nullptr; }

    /** Starts the 15 Hz tick (parameter streaming, status pushes, standby).
        The standalone calls this once its first navigation is under way. */
    void startTicking() { startTimerHz (15); }

    /** C++ -> JS: the one funnel every push goes through. Safe with no view
        attached — the event is dropped, which the page's own requests and the
        level-triggered status pushes recover from. */
    void emit (const juce::String& eventId, const juce::var& payload);

    // Pushes the host may need to trigger (device edits change the About
    // block; MidiInputManager's hot-plug callback re-lists devices).
    void emitAppInfo();
    void emitStatusChanged();
    void emitMidiDevices();

    /** Restarts the idle clock and wakes. Called from every bridge event that
        represents user intent — and by the shell's MIDI callback, since a
        footswitch press is user intent even while the rig is parked. */
    void noteStandbyActivity();

    // The plugin editor's last size, remembered here because the editor dies
    // with every close while the engine lives on (and persisted with the host
    // state, so a reopened project's window matches). The standalone never
    // reads these — its window remembers itself.
    int editorWidth  = 1040;
    int editorHeight = 640;

    // --- Host-saved state (the VST3's DAW-project persistence) -------------
    /** The full engine state as one JSON document: the rack's entries in
        applyRigEntries' shape, the split topology, the page's session blob
        (see handleWriteSession), the fixed-node settings the standalone keeps
        in audio_settings.xml, and the editor size.

        Callable from any thread — VST3 hosts may ask for state off the message
        thread (background autosave). On the message thread it captures fresh;
        elsewhere it serves the cache the 15 Hz tick refreshes (see
        refreshHostStateCacheIfDue), at most ~2 s stale. */
    juce::String currentHostState();

    /** Re-creates the engine from a currentHostState() document: session blob
        and fixed nodes synchronously, the rack through the ordinary rig-apply
        path (async plugin creation under the load mute and its watchdog). A
        newer apply supersedes an in-flight one via the load generation, so the
        latest state always wins. Message thread only. */
    void applyHostState (const juce::String& json);

    /** Something the host-saved state carries has changed. Audio-thread safe
        (an atomic); the capture itself happens on the engine tick. */
    void markHostStateDirty() noexcept { hostStateDirty.store (true, std::memory_order_release); }

private:
    plectrify::HostServices& host;

    // --- Web UI bridge ----------------------------------------------------
    void handleInsertModule (const juce::var& payload);
    void handleReplaceModule (const juce::var& payload);
    void handleRemoveModule (const juce::var& payload);
    void handleReorder (const juce::var& payload);
    void handleMoveModule (const juce::var& payload);
    void handleSwapModules (const juce::var& payload);
    void handleSetBypass (const juce::var& payload);
    void handleSetParam (const juce::var& payload);
    // Batched variants used by scene switches: many values / bypass flags in
    // one bridge event, applied without interrupting audio.
    void handleSetParams (const juce::var& payload);
    void handleSetBypassStates (const juce::var& payload);
    // TS registers which plugin parameters to poll, per module (only the mapped
    // ones), so the value-streaming timer stays cheap.
    void handleWatchParams (const juce::var& payload);
    void handleOpenEditor (const juce::var& payload);
    void handleCreateSplit (const juce::var& payload);
    void handleAddLane (const juce::var& payload);
    void handleRemoveLane (const juce::var& payload);
    void handleMoveLane (const juce::var& payload);
    void handleSetLaneMix (const juce::var& payload);
    void handleSetLaneSwitch (const juce::var& payload);
    void handleSetStatus (const juce::var& payload);
    // Looper pedal actions (toggle/stop/clear/undo). A verb, not state, so it
    // lives beside handleSetStatus rather than inside it — same reasoning as
    // standbyCommand.
    void handleLooperCommand (const juce::var& payload);
    /** Metronome pedal verbs. Toggle changes its transient enabled state;
        sync restarts the bar on the next audio block. */
    void handleMetronomeCommand (const juce::var& payload);
    // Clear archives before it wipes: snapshots the loop on the message thread
    // (the audio thread cannot apply the clear before its next block) and hands
    // it to the session store; looperSessionSaved carries the metadata the
    // TS-owned index needs. No-op when the looper holds nothing worth keeping.
    void saveLooperSessionBeforeClear();
    // Loads a saved session WAV back into the looper. One load in flight at a
    // time; the reply waits for the audio thread to adopt the staged buffer
    // (observed by the 15 Hz timer), so `ok` means the loop is actually there.
    void handleLooperLoadSession (const juce::var& payload);
    void emitLooperSessionLoaded (const juce::var& requestId, bool ok);
    // Opens a directory under the app-data sandbox in the OS file browser.
    // Directories only — startAsProcess on a file would execute it.
    void handleRevealAppFolder (const juce::var& payload);
    // Auto Standby's persisted preference (owned by the UI's AppSettings) and
    // its verbs (wake/sleep/activity). Deliberately not folded into
    // handleSetStatus: that is the live control surface the user drags and the
    // engine echoes at 15 Hz, so a settings write would race the echo — and
    // "absent field means no change" cannot express a verb.
    void handleSetStandby (const juce::var& payload);
    void handleStandbyCommand (const juce::var& payload);
    // Hands a link from the web UI (the feedback menu item) to the default
    // browser, since the WebView has no tabs to open it in.
    void handleOpenExternalUrl (const juce::var& payload);

    // The page's session metadata (knob mappings, module names, colours,
    // scenes) held in engine memory instead of working-rack.json. Only the
    // plugin build's page uses these: its working rack must ride the DAW
    // project rather than a global file two instances would fight over, and
    // must survive the page dying with every editor close. Same
    // request/response shape as writeFile/readFile (sessionWritten /
    // sessionRead replies).
    void handleWriteSession (const juce::var& payload);
    void handleReadSession (const juce::var& payload);

    /** The one JSON document getStateInformation persists. Message thread. */
    juce::String buildHostStateJson() const;

    /** Refreshes the cached capture when marked dirty, rate-limited to one
        capture per ~2 s — it serializes every plugin's state, which with a few
        NAM captures loaded is megabytes — and skipped entirely while a rig
        load holds the rack half-built (the finished apply re-marks it). Only
        run for hosts that persist engine state (HostServices::capturesHostState). */
    void refreshHostStateCacheIfDue();

    juce::var buildRackState() const;
    /** The split topology in the shape applyRigEntries consumes; shared by the
        rack snapshot the UI reads and the standby park. */
    juce::var buildRoutingState() const;
    void emitRackChanged();
    juce::var buildStatusState();

    // The list of plugins the UI's custom picker offers. Pushed on request and
    // whenever a scan changes the known-plugins list.
    juce::var buildPluginsState();
    void emitPluginsChanged();

    // Host facts for the About dialog's diagnostics: version, build provenance,
    // machine, audio device and plugin-library sizes. Only the exe knows any of
    // it, and the UI bundle it serves may be from an older build. Not static for
    // the session — the audio device and the plugin counts change — so it is
    // re-pushed whenever they do (see the shell's changeListenerCallback and
    // scanForPlugins).
    juce::var buildAppInfoState();
    void emitPluginScanChanged (const juce::String& status);

    // The plugin files the scanner skips (see PluginManager::unblacklistPlugins).
    // Paths, unlike the About block's count: this list is for the user's own
    // screen, where the file name is the only way to tell which plugin a retry
    // is about. Pushed on request, whenever a scan ends (the pedal blacklists
    // at the start of one) and after a retry clears entries.
    juce::var buildPluginBlacklistState();
    void emitPluginBlacklist();
    // Un-blacklists the payload's `paths` (all of them when absent) and rescans:
    // clearing an entry changes nothing the user can see until the plugin has
    // been loaded again.
    void handleRetryBlacklistedPlugins (const juce::var& payload);

    // --- Plugin catalogue ---------------------------------------------------
    // The downloadable plugin packages offered in the Packages panel. The
    // catalogue is fetched from the server (Debug builds read the source tree),
    // so `catalogueState` carries where it came from — a cached or missing
    // catalogue must not be mistaken for the current one.
    juce::var buildCatalogueState();
    void emitCatalogueState();
    void handleRequestCatalogue (const juce::var& payload);
    // Installs or updates the payload's `ids`. Progress rides its own event
    // stream rather than a request/response pair: a download runs for minutes,
    // far past JuceEngine.request()'s timeout.
    void handleInstallPackages (const juce::var& payload);
    void handleCancelInstall (const juce::var& payload);
    // Removes installed packages. Fast enough to need no progress stream, but
    // it answers with the same installFinished shape so the panel's error
    // handling is one path rather than two.
    void handleUninstallPackages (const juce::var& payload);

    // --- Rig capture/apply + generic file I/O -----------------------------
    // The UI/TypeScript owns rig format, naming, listing and session logic.
    // C++ only does what it alone can: capture the live plugins' state and
    // re-apply it, plus thin sandboxed file access under the app-data dir.
    void handleCaptureRig (const juce::var& payload);
    void handleApplyRig (const juce::var& payload);
    /** One module's plugin state, for a patch. The narrow sibling of
        captureRig/applyRig: a patch needs a single plugin's tone, and
        serialising the whole rack for it would move every other plugin's
        state (tens of megabytes with a few captures loaded) on every save. */
    void handleCaptureModuleState (const juce::var& payload);
    void handleApplyModuleState (const juce::var& payload);
    /** The state alone, for callers that already know which module they mean.
        Shared by handleCaptureModuleState and the TONE3000 service, so a tone
        swap starts from exactly what a patch save would have captured. */
    juce::String captureStateOf (const juce::String& moduleId,
                                 juce::String* pluginName = nullptr,
                                 juce::String* pluginVersion = nullptr) const;
    /** Instantiate a plugin off the graph purely to read its factory state and
        parameter list. The TONE3000 panel needs this when a tone is turned into
        a patch with no module to start from; it is the alternative to shipping
        a template blob that would rot against the plugin's version. */
    void captureFactoryState (const juce::String& pluginId,
                              std::function<void (juce::String, juce::var)> onDone);
    /** The scanned Neural Amp Modeler's plugin id, or empty if no scan has
        found one yet. Matched on the plugin's own name the same loose way the
        UI does — it reports itself as "NeuralAmpModeler" and is written
        "Neural Amp Modeler" nearly everywhere else, and spacing is not
        identity. Used by the TONE3000 service, which needs a plugin to build a
        capture's state into and can no longer be told "install it first": it
        ships with Plectrify. */
    juce::String findNamPluginId();
    /** Scan the shipped plugin directory alone, and only when what it contains
        is not in the cache yet.

        Plugin scanning is user-triggered everywhere else, deliberately: it
        loads third-party code the user chose to put on their machine. This one
        is different in both halves — it is our own binary, in our own folder,
        put there by our own installer — and it has to be known on first launch
        without anyone being told to press Rescan, because the app assumes it is
        there. Scoped to that directory, so it is not a user-wide scan wearing
        a different name. */
    void scanBundledPluginsIfNeeded();
    /** Every live slot serialised in applyRigEntries' own shape (clientId,
        laneId, description, state, bypassed), so a rig capture and a standby
        park share one serialiser. */
    juce::Array<juce::var> captureRackEntries() const;
    /** Drops every plugin instance: closes editors, dissolves splits, detaches
        the engine as a parameter listener, and removes the nodes. Shared by
        a rig apply and a deep standby park. */
    void tearDownRack();
    // Sequentially re-creates rig slots (plugin creation is async), preserving
    // order; a slot whose plugin can't be created is skipped, recorded in
    // `failures`, and reported (alert + rigApplied payload) when the apply ends.
    // A void requestId means no UI request is awaiting this (a standby wake
    // drives it internally): the reply and the failure alert are then skipped,
    // and `onFinished` closes the loop instead.
    void applyRigEntries (std::shared_ptr<juce::Array<juce::var>> entries,
                          juce::var routing, int index, juce::var requestId,
                          std::shared_ptr<juce::Array<juce::var>> failures,
                          int loadGeneration,
                          std::shared_ptr<std::function<void()>> onFinished = {});
    void emitRigApplyProgress (const juce::var& requestId, int current, int total,
                               const juce::String& pluginName = {}, bool done = false);

    // The output stays silent from the first teardown until shortly after the
    // last plugin is back, so the user never hears the partial chain. Every
    // apply takes a generation: a release only lands if it still owns the mute,
    // so an overlapping apply (or the watchdog) can't un-mute someone else's.
    int beginRigLoadMute();
    void endRigLoadMute (int generation);
    int rigLoadGeneration = 0;
    /** True while `generation` still owns the rack. Every whole-rack operation
        — a rig apply, a standby wake, a standby park — bumps
        rigLoadGeneration, which strands the superseded operation's deferred
        continuations: plugin creation is async, so they must bail rather than
        mutate the rack that replaced the one they were building. */
    bool ownsRack (int generation) const noexcept { return generation == rigLoadGeneration; }
    // True from the first teardown until the load mute is released, so standby
    // never engages on a half-assembled rack.
    bool rigLoadInFlight = false;

    // --- Auto Standby -----------------------------------------------------
    // Reclaims CPU (stage 1) and RAM (stage 2) after a stretch of input
    // silence, so a rig left running through a break stops costing anything.
    // The controller owns only the policy; every effect lands in these methods.
    void enterLightStandby();
    void exitLightStandby();
    void enterDeepStandby();
    void beginWakeFromDeepStandby();
    /** True while it would be unsafe or rude to drop into standby. Each of
        these also means the user is doing something, so the controller treats a
        blocked tick as activity and restarts the idle clock. The host-shaped
        reasons (no device, wizard meters armed) come from
        HostServices::blocksAutoStandby(). */
    bool standbyIsBlocked() const;
    /** Brings the rig back before a rack-mutating bridge event runs. Light
        standby wakes synchronously and returns true; a deep wake is a
        multi-second async rebuild, so it returns false and the caller drops the
        event — the UI is already locked by the apply-progress busy state. */
    bool wakeForRackEdit();
    /** Forgets any park and clears the standby flags without running a wake:
        for a rig apply, which is about to rebuild the rack itself. */
    void abandonStandby();

    StandbyController standby;
    // The rig while deep standby holds it: entries in applyRigEntries' shape
    // plus the split topology. Non-empty exactly while parked — from the park
    // until the wake reports back, whether or not every plugin came back — so
    // it is the only copy of the user's live tone for exactly that window.
    juce::var parkedRack;
    juce::var parkedRouting;
    bool isParked() const noexcept { return parkedRack.getArray() != nullptr; }
    // Plugins that could not be restored on the last deep wake, surfaced in the
    // status payload rather than a modal.
    juce::Array<juce::var> standbyWakeFailures;
    // Sampled once per tick so the status payload and the policy agree.
    bool standbyBlocked = false;

    void handleWriteFile (const juce::var& payload);
    void handleReadFile (const juce::var& payload);
    void emitFileReadChunk (juce::var requestId, std::shared_ptr<juce::String> text,
                            juce::String encoding, int offset, int chunkIndex);
    void handleListFiles (const juce::var& payload);
    void handleDeleteFile (const juce::var& payload);
    juce::File appDataDir() const;
    // Resolves a UI-supplied relative path under appDataDir(); returns false if
    // it escapes that directory (defends against the webview writing anywhere).
    bool resolveAppFile (const juce::String& rel, juce::File& out) const;

    // Patch packs installed from the catalogue, under the shared package root
    // rather than appDataDir(): %PROGRAMDATA%/Plectrify/patches on Windows,
    // /Users/Shared/Plectrify/patches on macOS.
    static juce::File sharedPatchesDir();
    // The read-only counterpart to resolveAppFile, rooted at sharedPatchesDir().
    // Scoped to that one folder and not to the whole package root, so a read
    // cannot enumerate the sibling VST3 load path. Only handleReadFile and
    // handleListFiles consult it — handleWriteFile and handleDeleteFile have no
    // path to it at all, which is what keeps the page unable to touch anything
    // outside the per-user app-data sandbox no matter what it asks for.
    bool resolveSharedFile (const juce::String& rel, juce::File& out) const;
   #if defined(PLECTRIFY_CONTENT_SOURCE_DIR)
    // Debug-only: a patch pack's sources in the repo shadow the installed copy
    // of the same package id, so authoring one is "edit patch.json and restart"
    // rather than build, publish, install. Returns the source folder for an id
    // (this platform's build in preference to the OS-neutral one), or a null
    // File when the repo has no pack by that name — in which case the installed
    // copy answers as it always did.
    //
    // Read-only, like the root it shadows: nothing here is on a writable path,
    // and the override lives in a compile-time symbol that does not exist
    // outside Debug rather than in a setting a shipped build could be talked
    // into honouring.
    //
    // Keyed by the folder a patch occupies in patches/, which is not always the
    // package id: a source folder holding a patch.json is one patch and installs
    // wrapped in a folder named for the package, while a pack of several ships
    // flat and each of its subfolders installs under its own name.
    static std::map<juce::String, juce::File> sharedPatchSources();
    static juce::File sharedPatchSourceDir (const juce::String& patchId);
    // The ids those folders offer, for listing the shared root.
    static juce::StringArray sharedPatchSourceIds();
    // The one writable path in this build, and it deliberately does not point
    // where resolveSharedFile reads from: a write lands in the repo's sources
    // for the pack, never in the installed copy. Refuses a pack the repo does
    // not carry, and anything naming the pack folder itself rather than a file
    // inside it.
    static bool resolveSharedSourceFile (const juce::String& rel, juce::File& out);
   #endif
    // Picks the resolver for a payload's optional "root" ("app" by default,
    // "shared" for a patch pack). Unknown roots resolve as "app".
    bool resolveReadableFile (const juce::var& payload, const juce::String& rel,
                              juce::File& out) const;
    // The writing counterpart. "app" is the whole of it in a shipped build —
    // "shared" resolves to nothing at all there, rather than falling back to
    // the app-data root. A Debug build resolves it against the pack's sources
    // in the repo, so a pack can be re-saved from the app while it is being
    // authored; see resolveSharedSourceFile.
    bool resolveWritableFile (const juce::var& payload, const juce::String& rel,
                              juce::File& out) const;

    // Per-module (keyed by clientId) set of plugin parameter indices the UI has
    // mapped to knobs — the only params the timer polls and streams back.
    std::map<juce::String, std::vector<int>> watchedParams;
    // Pushes a value→text lookup table for every watched param so the UI can
    // show the plugin's formatted value locally while a knob drags, without
    // waiting on the polling timer.
    void emitParamTexts();
    void timerCallback() override; // pushes live parameter values to the UI
    // Plugin editors may notify from the audio thread. These callbacks only
    // flip an atomic; timerCallback publishes the change on the message thread.
    // Parameter changes and non-parameter/program state changes are tracked
    // separately so the UI can apply different dirty policies to each.
    void audioProcessorParameterChanged (juce::AudioProcessor*, int, float) override;
    void audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails&) override;
    std::atomic<bool> pluginParamsChanged { false };
    std::atomic<bool> pluginInternalStateChanged { false };
    // Set when a plugin reports a latency change; the timer re-bakes the
    // graph's latency compensation on the message thread.
    std::atomic<bool> graphLatencyDirty { false };

    std::optional<juce::AudioProcessorGraph::NodeID> findNode (const juce::String& moduleId) const;

    // --- Plugin / audio ---------------------------------------------------
    /** The scanned plugin matching a picker id, or nullopt (with a user-facing
        alert being the caller's job) when the list no longer contains it. */
    std::optional<juce::PluginDescription> findKnownPlugin (const juce::String& pluginId);
    /** Instantiates the plugin off the message thread and adds it to the rack.
        @param openEditor  pop the plugin's own editor once it lands — wanted for
                           a module built from scratch, not for one restored from
                           a patch, which already carries its tone. */
    void addPluginFromDescription (const juce::PluginDescription& desc, int index,
                                   const juce::String& clientId, const juce::String& laneId = {},
                                   std::optional<int> serialPosition = std::nullopt,
                                   const juce::String& beforeGroupId = {},
                                   bool openEditor = true);
    void scanForPlugins();

    /** The scan that follows a package install or removal: the managed plugin
        directory alone, never the whole search path.

        That directory is the only one a package run can have written to, and
        scanning one folder of ours is quick enough that the list catches up
        while the user is still looking at the row they clicked — where a full
        scan walks every VST3 folder on the machine, loading each plugin in this
        process, and takes long enough to need covering up. A removal is served
        as well as an install: every scan begins by pruning known-list entries
        whose file is gone (PluginManager::pruneMissingPlugins), wherever they
        lived. */
    void scanManagedPlugins();

    /** A scan of the whole search path on a package run's behalf: what the
        first-run starter install asks for, so the plugins the user already had
        in their own folders are found in the same step as the ones just
        installed — on a machine that has never been scanned, nothing else
        would look there until they pressed Rescan. Queued rather than dropped
        when a scan is in flight, exactly as scanManagedPlugins is. */
    void requestFullRescan();

    /** What all of the above are: one scan of `paths`, reporting scanning /
        complete to the page. Returns false without doing anything when a scan
        is already running — that one keeps emitting its own progress. */
    bool startScan (const juce::FileSearchPath& paths);

    /** Set when a package run's scan could not start because another was in
        flight, and consumed when that one completes. A scan that began before
        the install or removal cannot describe what it did. */
    bool pendingManagedRescan = false;

    /** The same for a run that asked for the whole search path (the first-run
        starter install — see handleInstallPackages). Takes precedence over the
        narrow one when both are set: a full scan covers the managed directory
        as well, so running it alone loses nothing. */
    bool pendingFullRescan = false;

    void openEditorFor (juce::AudioProcessorGraph::NodeID nodeID);

    /** Names this engine's write-through temporaries apart from every other
        engine's. The data root is shared by construction — the standalone and
        each plugin instance write the same paths — so a fixed ".tmp" is a file
        two writers fight over. Unique per instance and per process; the price
        is that a crash between write and swap leaves one behind rather than
        having it overwritten by the next write. */
    const juce::String writerId { juce::Uuid().toDashedString().upToFirstOccurrenceOf ("-", false, false) };

    // --- Owned state ------------------------------------------------------
    PluginManager       pluginManager;
    CatalogueInstaller  catalogue;
    RackProcessor       rack;

    // TONE3000. Destroyed in the engine's destructor, which the shell runs
    // before the web view's: on Windows the sign-in window owns a second
    // WebView2 environment whose COM release is asynchronous.
    std::unique_ptr<Tone3000Service> tone3000;

    // Looper session archive (WAVs under looper-sessions/). Completion
    // callbacks are WeakReference-guarded, so destruction order against the
    // view is not load-bearing.
    std::unique_ptr<LooperSessionStore> looperSessions;
    // One session load in flight at a time. `staged` flips once the decoded
    // buffer has been handed to the looper — only then does the consumed flag
    // mean *this* load, not a previous one.
    bool looperLoadInFlight = false;
    bool looperLoadStaged = false;
    juce::var pendingLooperLoadRequestId;
    juce::uint32 looperLoadStartMs = 0;

    // ~1 Hz cache for the RAM readout in the status payload; the 15 Hz status
    // timer must not hit GetProcessMemoryInfo every tick.
    double cachedProcessRamMb { 0.0 };
    juce::uint32 lastRamPollMs { 0 };
    const int systemRamTotalMb { juce::SystemStats::getMemorySizeInMegabytes() };
    // Session length, reported in the diagnostics: "it drifts after a few hours"
    // is a different bug from "it is wrong from the first note".
    const juce::uint32 sessionStartMs { juce::Time::getMillisecondCounter() };

    std::map<juce::uint32, std::unique_ptr<PluginEditorWindow>> editorWindows;

    // --- Attached view ----------------------------------------------------
    // Non-owning; the standalone shell / plugin editor owns the component.
    juce::WebBrowserComponent* webView = nullptr;

    // --- Host-saved state -------------------------------------------------
    // The page's session metadata, engine-held for the plugin build (see
    // handleWriteSession). Serialized into the host state verbatim.
    juce::String sessionBlob;
    // The capture cache an off-message-thread getStateInformation is served
    // from. The lock guards only the string swap; the capture itself runs
    // unlocked on the message thread.
    juce::CriticalSection hostStateLock;
    juce::String cachedHostState;
    std::atomic<bool> hostStateDirty { true };
    juce::uint32 lastHostStateCaptureMs = 0;

    // Last graph latency handed to HostServices::graphLatencyChanged; the tick
    // publishes on a diff because the graph re-bakes its render sequence
    // asynchronously after a topology edit.
    int lastPublishedLatency = 0;

    JUCE_DECLARE_WEAK_REFERENCEABLE (PlectrifyEngine)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PlectrifyEngine)
};
