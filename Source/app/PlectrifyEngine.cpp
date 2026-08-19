#include "PlectrifyEngine.h"
#include "AppPaths.h"
#include "BuildInfo.h"
#include "EngineHelpers.h"
#include "SystemStatsHelper.h"

#include <algorithm>

namespace
{
    // Every parameter the plugin exposes — the palette the user maps knobs from.
    // isBoolean is a property of the parameter (not the knob), so it lives here.
    juce::var availableParamsToVar (juce::AudioPluginInstance& inst)
    {
        juce::Array<juce::var> available;
        for (auto* p : inst.getParameters())
        {
            auto* po = new juce::DynamicObject();
            po->setProperty ("index", p->getParameterIndex());
            po->setProperty ("name", p->getName (32));
            po->setProperty ("defaultValue", p->getDefaultValue());
            auto valueStrings = p->getAllValueStrings();
            const auto numSteps = p->getNumSteps();
            const auto isMultiChoice = numSteps > 2 && numSteps <= 128;
            if (isMultiChoice)
            {
                // Several VST3s expose a finite step count but leave
                // getAllValueStrings() empty. Ask the parameter to format each
                // normalised step so selectors such as mono/left/right/stereo
                // still reach the UI as discrete controls.
                if (valueStrings.size() != numSteps)
                {
                    valueStrings.clear();
                    for (int step = 0; step < numSteps; ++step)
                        valueStrings.add (p->getText ((float) step / (float) (numSteps - 1), 64));
                }
            }
            else if (valueStrings.isEmpty())
            {
                // Some VST3s advertise a selector as continuous even though its
                // formatted value switches between a handful of names. Detect
                // those stable regions without misclassifying genuinely
                // continuous controls (which produce many distinct strings).
                constexpr int samples = 256;
                juce::String lastText;
                for (int sample = 0; sample <= samples; ++sample)
                {
                    const auto normalised = (float) sample / (float) samples;
                    const auto formatted = p->getText (normalised, 64).trim();
                    if (formatted != lastText)
                    {
                        valueStrings.add (formatted);
                        lastText = formatted;
                        if (valueStrings.size() > 32)
                            break;
                    }
                }

                bool hasEmptyChoice = false;
                for (const auto& valueString : valueStrings)
                    hasEmptyChoice = hasEmptyChoice || valueString.isEmpty();

                if (valueStrings.size() < 2 || valueStrings.size() > 32 || hasEmptyChoice)
                    valueStrings.clear();
            }

            if (valueStrings.size() > 1)
            {
                juce::Array<juce::var> choices;
                for (const auto& valueString : valueStrings)
                    choices.add (valueString);
                po->setProperty ("valueStrings", choices);
            }
            // Many plugins expose on/off toggles as a 2-step discrete param
            // without flagging them boolean, so treat those as switches too.
            po->setProperty ("isBoolean", p->isBoolean() || p->getNumSteps() == 2);
            // Read-only readouts (meters, tuner/level outputs) are non-automatable;
            // the UI defaults a knob mapped onto one to a meter display.
            po->setProperty ("isReadOnly", ! p->isAutomatable());
            available.add (juce::var (po));
        }
        return available;
    }
}

PlectrifyEngine::PlectrifyEngine (plectrify::HostServices& hostServices)
    : host (hostServices)
{
    // Before anything can prepare the graph: the looper's buffers are allocated
    // in prepareToPlay, so a host that does not offer it has to say so first.
    const auto caps = host.capabilities();
    rack.setToolAvailability ({ caps.looper, caps.metronome, caps.feedbackGuard });

    looperSessions = std::make_unique<LooperSessionStore> (appDataDir().getChildFile ("looper-sessions"));

    // Its first act may be to emit a session state; with no web view attached
    // yet that push is dropped, and the page's own requestTone3000 at boot
    // re-asks — the same recovery every occluded-window drop relies on.
    tone3000 = std::make_unique<Tone3000Service> (Tone3000Service::Delegate {
        [this] (const juce::String& moduleId) { return captureStateOf (moduleId); },
        [this] (const juce::String& pluginId, std::function<void (juce::String, juce::var)> onDone)
        { captureFactoryState (pluginId, std::move (onDone)); },
        [this] { return findNamPluginId(); },
        [this] (const juce::String& eventId, const juce::var& payload) { emit (eventId, payload); } });

    // The shipped plugin has to be in the list on first launch: it is part of
    // the installation, and nothing about it is the user's to opt into.
    scanBundledPluginsIfNeeded();

    // --- One-shot: retire the catalogue's copy of a now-bundled plugin ----
    // Neural Amp Modeler ships inside Plectrify and is scanned from there. A copy
    // installed from the Packages panel by an older version would show up in
    // the plugin list a second time, same name and a different path, with no
    // way for the user to tell which one a patch means. Removed through the
    // ordinary uninstall path, so a bundle they replaced with a build of their
    // own is disowned rather than deleted — and it is a no-op on every machine
    // that never installed it, which is every machine from this release on.
    //
    // Guarded on the shipped copy actually being there, which is the whole
    // justification: with no bundled plugin this would not be removing a
    // duplicate, it would be removing the user's only Neural Amp Modeler — and
    // that is exactly the case in a Debug tree with nothing staged.
    if (PluginManager::getBundledPluginDirectory()
            .getChildFile ("NeuralAmpModeler.vst3")
            .exists())
    {
        juce::WeakReference<PlectrifyEngine> safe (this);
        catalogue.retirePackageAsync ("neural-amp-modeler",
                                      [safe] (CatalogueInstaller::Result)
                                      {
                                          // Back on the message thread by the
                                          // uninstaller's own contract; a rescan
                                          // is what makes the duplicate go — and
                                          // the retired copy was in the managed
                                          // directory, so that is all it reads.
                                          if (safe != nullptr)
                                              safe->scanManagedPlugins();
                                      });
    }

    standby.setCallbacks ({
        [this] { enterLightStandby(); },
        [this] { exitLightStandby(); },
        [this] { enterDeepStandby(); },
        [this] { beginWakeFromDeepStandby(); },
        // Transitions are worth a status push of their own: the 15 Hz poll would
        // otherwise leave the UI up to 66 ms behind a wake the user just caused.
        [this] { emitStatusChanged(); },
    });
}

PlectrifyEngine::~PlectrifyEngine()
{
    stopTimer();

    for (const auto& slot : rack.getSlots())
        if (auto* instance = rack.getPluginInstance (slot.nodeID))
            instance->removeListener (this);

    editorWindows.clear();
    // The shell destroys the engine before the web view, which is what makes
    // this the right place for the TONE3000 teardown: on Windows its sign-in
    // window owns a second WebView2 environment, and two of them tearing down
    // COM at once is the failure that ordering avoids.
    tone3000.reset();
    webView = nullptr;

    // A clean quit is not a crash: closing the app while a session restore is
    // still in flight must not quarantine that session on the next launch.
    // (Name matches RESTORE_SENTINEL in JuceEngine.ts.)
    //
    // The standalone's alone, though the data root is shared: the plugin never
    // writes or reads it — its session rides the DAW project, whose crash story
    // is the host's — so deleting it there would only disarm the standalone's
    // quarantine, and a DAW closing a project mid-restore is exactly when.
    if (! host.capturesHostState())
        appDataDir().getChildFile ("restore_in_progress").deleteFile();
}

void PlectrifyEngine::emit (const juce::String& eventId, const juce::var& payload)
{
    if (webView != nullptr)
        webView->emitEventIfBrowserIsVisible (eventId, payload);
}

juce::WebBrowserComponent::Options PlectrifyEngine::registerEventListeners (juce::WebBrowserComponent::Options options)
{
    // Auto Standby treats these bridge events as user activity. It is an
    // allowlist rather than a blanket wrap for a concrete reason: plugins that
    // expose meter parameters notify continuously, which drives the UI's
    // session autosave in a loop forever. If writeFile counted as activity,
    // standby would never engage on exactly the rigs that most need it — so
    // everything the UI sends on a timer (requestStatus, watchParams,
    // captureRig, the file I/O) is deliberately absent.
    //
    // A rack-mutating event additionally has to wait for the rig to be back:
    // while parked there are no instances to mutate, and buildRackState() would
    // report an empty rack. A light wake is synchronous so the event proceeds;
    // a deep wake is a multi-second rebuild, so the event is dropped and the
    // user re-issues it once the progress dialog clears.
    const auto onRackEdit = [this] (void (PlectrifyEngine::*handler) (const juce::var&))
    {
        return [this, handler] (juce::var v) { if (wakeForRackEdit()) (this->*handler) (v); };
    };
    const auto onActivity = [this] (std::function<void (juce::var)> handler)
    {
        return [this, handler] (juce::var v) { noteStandbyActivity(); handler (v); };
    };

    return options
        // Which binary this page is inside, baked into window.__JUCE__ before
        // the page's first script runs. The same fact rides appInfo, but that
        // is a push, and emitEventIfBrowserIsVisible drops pushes while the
        // view is hidden — which is how a DAW can open an editor. The page's
        // session-restore decision is one-shot and must not be guessed: a page
        // that mistakes a plugin for the standalone applies the standalone's
        // autosaved working rack over the DAW's session.
        .withInitialisationData ("host", juce::String (host.hostKind()))
        // Not an activity event (the UI asks on startup), but it must not answer
        // while deep standby holds the rig parked: buildRackState() would report
        // an empty rack, which prunes every knob mapping and lane name and lets
        // the session autosave persist the loss. The UI's existing snapshot is
        // still correct, and the wake emits a fresh one.
        .withEventListener ("requestRack",      [this] (juce::var)   { if (! isParked()) emitRackChanged(); })
        .withEventListener ("requestStatus",    [this] (juce::var)   { emitStatusChanged(); })
        .withEventListener ("requestPlugins",   [this] (juce::var)   { emitPluginsChanged(); })
        // Host facts for the About dialog. Asked at boot and again whenever the
        // dialog opens (a push can be dropped while the window is occluded), so
        // not an activity event — and safe while parked, since it reads no plugin.
        .withEventListener ("requestAppInfo",   [this] (juce::var)   { emitAppInfo(); })
        // Same shape as requestAppInfo: asked at boot, when the MIDI dialog
        // opens, and by its Refresh button (a push can be dropped while the
        // window is occluded); safe while parked, since it reads no plugin.
        // Re-enumerates before answering so the reply reflects this instant
        // rather than the hot-plug poll's last pass.
        .withEventListener ("requestMidiDevices", [this] (juce::var)
        {
            host.refreshMidiDevices();
            emitMidiDevices();
        })
        .withEventListener ("insertModule",     onRackEdit (&PlectrifyEngine::handleInsertModule))
        .withEventListener ("replaceModule",    onRackEdit (&PlectrifyEngine::handleReplaceModule))
        .withEventListener ("removeModule",     onRackEdit (&PlectrifyEngine::handleRemoveModule))
        .withEventListener ("reorder",          onRackEdit (&PlectrifyEngine::handleReorder))
        .withEventListener ("moveModule",       onRackEdit (&PlectrifyEngine::handleMoveModule))
        .withEventListener ("swapModules",      onRackEdit (&PlectrifyEngine::handleSwapModules))
        .withEventListener ("setBypass",        onRackEdit (&PlectrifyEngine::handleSetBypass))
        .withEventListener ("setParam",         onRackEdit (&PlectrifyEngine::handleSetParam))
        // Batched variants used by scene switches (one bridge hop per switch).
        .withEventListener ("setParams",        onRackEdit (&PlectrifyEngine::handleSetParams))
        .withEventListener ("setBypassStates",  onRackEdit (&PlectrifyEngine::handleSetBypassStates))
        .withEventListener ("watchParams",      [this] (juce::var v) { handleWatchParams (v); })
        .withEventListener ("openEditor",       onRackEdit (&PlectrifyEngine::handleOpenEditor))
        .withEventListener ("createSplit",      onRackEdit (&PlectrifyEngine::handleCreateSplit))
        .withEventListener ("addLane",          onRackEdit (&PlectrifyEngine::handleAddLane))
        .withEventListener ("removeLane",       onRackEdit (&PlectrifyEngine::handleRemoveLane))
        .withEventListener ("moveLane",         onRackEdit (&PlectrifyEngine::handleMoveLane))
        .withEventListener ("setLaneMix",       onRackEdit (&PlectrifyEngine::handleSetLaneMix))
        .withEventListener ("setLaneSwitch",    onRackEdit (&PlectrifyEngine::handleSetLaneSwitch))
        // Gains and the tuner are activity but touch no plugin, so they work
        // while parked and must not wait for a rebuild.
        .withEventListener ("setStatus",        onActivity ([this] (juce::var v) { handleSetStatus (v); }))
        // A looper action is a foot on a pedal — activity by definition. It
        // touches no plugin (the looper is a fixed node), so like the gains it
        // works while parked and never waits for a rebuild.
        .withEventListener ("looperCommand",    onActivity ([this] (juce::var v) { handleLooperCommand (v); }))
        .withEventListener ("metronomeCommand", onActivity ([this] (juce::var v) { handleMetronomeCommand (v); }))
        .withEventListener ("looperLoadSession",onActivity ([this] (juce::var v) { handleLooperLoadSession (v); }))
        .withEventListener ("revealAppFolder",  onActivity ([this] (juce::var v) { handleRevealAppFolder (v); }))
        // No-ops where the host owns suspension (a DAW's plugin has no business
        // parking itself under an offline render); the UI hides the surface
        // behind the same capability.
        .withEventListener ("setStandby",       [this] (juce::var v) { if (host.capabilities().autoStandby) handleSetStandby (v); })
        .withEventListener ("standbyCommand",   [this] (juce::var v) { if (host.capabilities().autoStandby) handleStandbyCommand (v); })
        .withEventListener ("startWindowResize",onActivity ([this] (juce::var v) { host.handleStartWindowResize (v); }))
        .withEventListener ("setWindowTheme",   [this] (juce::var v) { host.handleSetWindowTheme (v); })
        .withEventListener ("setEditorSize",    [this] (juce::var v) { host.handleSetEditorSize (v); })
        .withEventListener ("scanPlugins",      onActivity ([this] (juce::var)   { scanForPlugins(); }))
        // Reads a list the scan thread owns while it runs, so it is answered
        // from the message thread like requestPlugins; the retry itself refuses
        // mid-scan (PluginManager::unblacklistPlugins).
        .withEventListener ("requestPluginBlacklist", [this] (juce::var) { emitPluginBlacklist(); })
        .withEventListener ("retryBlacklistedPlugins", onActivity ([this] (juce::var v) { handleRetryBlacklistedPlugins (v); }))
        // Plugin catalogue. Installing is user intent, but a download runs for
        // minutes with no further interaction, so onActivity alone would not
        // keep the app awake — standbyIsBlocked() covers the run itself.
        .withEventListener ("requestCatalogue", [this] (juce::var v) { handleRequestCatalogue (v); })
        .withEventListener ("installPackages", onActivity ([this] (juce::var v) { handleInstallPackages (v); }))
        .withEventListener ("cancelInstall",  onActivity ([this] (juce::var v) { handleCancelInstall (v); }))
        .withEventListener ("uninstallPackages", onActivity ([this] (juce::var v) { handleUninstallPackages (v); }))
        .withEventListener ("openAudioSettings",onActivity ([this] (juce::var)   { host.handleOpenAudioSettings(); }))
        // The setup wizard's own view of the audio stack. Asked for when it
        // opens and by its Refresh button; `rescan` re-enumerates the driver
        // families, which loads every ASIO driver on the machine and is far too
        // slow to do on a push nobody asked for.
        .withEventListener ("requestAudioDevices", onActivity ([this] (juce::var v) { host.handleRequestAudioDevices (v); }))
        .withEventListener ("setAudioDevice",    onActivity ([this] (juce::var v) { host.handleSetAudioDevice (v); }))
        // Not an activity event: the wizard arms this and then asks the player
        // to sit still and strum, which is exactly the stretch standby must
        // keep its hands off — standbyIsBlocked() covers it while it is armed.
        .withEventListener ("watchInputLevels",  [this] (juce::var v) { host.handleWatchInputLevels (v); })
        .withEventListener ("openExternalUrl",  onActivity ([this] (juce::var v) { handleOpenExternalUrl (v); }))
        // Rig capture/apply + generic file I/O (TypeScript owns rig format).
        .withEventListener ("captureRig",       [this] (juce::var v) { handleCaptureRig (v); })
        .withEventListener ("applyRig",         [this] (juce::var v) { handleApplyRig (v); })
        // One module's tone, for a patch. The capture is a read and answers
        // while parked (from the park snapshot, like captureRig); the apply
        // needs a live instance, so it waits for the rig like setParam does.
        .withEventListener ("captureModuleState", [this] (juce::var v) { handleCaptureModuleState (v); })
        .withEventListener ("applyModuleState",  onRackEdit (&PlectrifyEngine::handleApplyModuleState))
        .withEventListener ("writeFile",        [this] (juce::var v) { handleWriteFile (v); })
        .withEventListener ("readFile",         [this] (juce::var v) { handleReadFile (v); })
        .withEventListener ("listFiles",        [this] (juce::var v) { handleListFiles (v); })
        .withEventListener ("deleteFile",       [this] (juce::var v) { handleDeleteFile (v); })
        // The engine-held session document the plugin build's page uses in
        // place of working-rack.json — see handleWriteSession. Deliberately
        // not activity events, exactly as the file I/O is not.
        .withEventListener ("writeSession",     [this] (juce::var v) { handleWriteSession (v); })
        .withEventListener ("readSession",      [this] (juce::var v) { handleReadSession (v); })
        // TONE3000. Every one of these is forwarded verbatim: the service owns
        // the session, the network and the download root, and the engine only
        // routes. The list is short because browsing is not on this side of
        // the bridge at all — `tone3000Connect` opens TONE3000's own window,
        // and a tone picked there is downloaded and applied natively. What
        // comes back is a progress stream (a capture on a slow connection
        // outlives any request timeout) followed by a fresh tone3000State the
        // page reconciles from.
        .withEventListener ("requestTone3000",      [this] (juce::var)   { if (tone3000) tone3000->pushState(); })
        .withEventListener ("tone3000Connect",      [this] (juce::var v) { if (tone3000) tone3000->connect (v); })
        .withEventListener ("tone3000Disconnect",   [this] (juce::var)   { if (tone3000) tone3000->disconnect(); })
        .withEventListener ("tone3000SplashSeen",   [this] (juce::var)   { if (tone3000) tone3000->markSplashSeen(); })
        .withEventListener ("tone3000CancelInstall",[this] (juce::var)   { if (tone3000) tone3000->cancelInstall(); })
        .withEventListener ("tone3000SelectModel",  [this] (juce::var v) { if (tone3000) tone3000->selectModel (v); })
        .withEventListener ("tone3000Verify",       [this] (juce::var v) { if (tone3000) tone3000->verify (v); })
        .withEventListener ("tone3000Repair",       [this] (juce::var v) { if (tone3000) tone3000->repair (v); });
}

// ---------------------------------------------------------------------------
// C++ -> JS: rack snapshot + live parameter values.
// ---------------------------------------------------------------------------
juce::var PlectrifyEngine::buildRackState() const
{
    // Audio-truth only: ordered nodes with plugin name, bypass, and the param
    // palette. Knob mappings + display names are TS-owned and joined there,
    // keyed by clientId.
    juce::Array<juce::var> modules;
    for (const auto& slot : rack.getSlots())
    {
        auto* mod = new juce::DynamicObject();
        mod->setProperty ("id", slot.clientId);
        mod->setProperty ("name", slot.name);
        mod->setProperty ("bypassed", slot.bypassed);
        if (slot.laneId.isNotEmpty())
            mod->setProperty ("laneId", slot.laneId);
        if (slot.missing)
            mod->setProperty ("missing", true);

        if (auto* inst = rack.getPluginInstance (slot.nodeID))
        {
            mod->setProperty ("availableParams", availableParamsToVar (*inst));
            // Identity for the About dialog's diagnostics: which build of which
            // plugin is in the chain. Not fileOrIdentifier — that is a path
            // under the user's home directory.
            const auto desc = inst->getPluginDescription();
            mod->setProperty ("pluginVersion", desc.version);
            mod->setProperty ("pluginManufacturer", desc.manufacturerName);
        }
        else
        {
            mod->setProperty ("availableParams", juce::Array<juce::var>{});
        }

        modules.add (juce::var (mod));
    }

    auto* snapshot = new juce::DynamicObject();
    snapshot->setProperty ("revision", juce::String (rack.getRevision()));
    snapshot->setProperty ("modules", modules);
    snapshot->setProperty ("routing", buildRoutingState());
    return juce::var (snapshot);
}

juce::var PlectrifyEngine::buildRoutingState() const
{
    // The split topology in exactly the shape applyRigEntries' applyGroup
    // consumes, so the same snapshot serves the UI, a saved rig and a deep
    // standby park.
    juce::Array<juce::var> groups;
    for (const auto& group : rack.getSplitStates())
    {
        juce::Array<juce::var> lanes;
        for (const auto& lane : group.lanes)
        {
            auto* item = new juce::DynamicObject();
            item->setProperty ("id", lane.id);
            item->setProperty ("gain", lane.gain);
            item->setProperty ("pan", lane.pan);
            item->setProperty ("muted", lane.muted);
            item->setProperty ("soloed", lane.soloed);
            lanes.add (juce::var (item));
        }

        auto* item = new juce::DynamicObject();
        item->setProperty ("id", group.id);
        item->setProperty ("position", group.position);
        if (group.activeLaneId.isNotEmpty())
            item->setProperty ("activeLaneId", group.activeLaneId);
        item->setProperty ("lanes", lanes);
        groups.add (juce::var (item));
    }

    auto* routing = new juce::DynamicObject();
    routing->setProperty ("groups", groups);
    return juce::var (routing);
}

void PlectrifyEngine::emitRackChanged()
{
    // Every topology or bypass edit funnels through here, which makes it the
    // one place the host-saved state learns the rack moved.
    markHostStateDirty();
    emit ("rackChanged", buildRackState());
}

juce::var PlectrifyEngine::buildStatusState()
{
    const auto tuner = rack.getTunerReading();
    auto* status = new juce::DynamicObject();
    status->setProperty ("inputGainDb", rack.getInputGainDb());
    status->setProperty ("outputGainDb", rack.getOutputGainDb());
    status->setProperty ("inputPeak", rack.consumeInputPeak());
    status->setProperty ("outputPeak", rack.consumeOutputPeak());
    status->setProperty ("tunerEnabled", rack.isTunerEnabled());
    status->setProperty ("midiTunerActive", rack.isMidiTunerActive());
    // Level-triggered like standby: the latch is re-stated every tick, so a
    // dropped push cannot leave the page showing an unmuted rig that is silent.
    status->setProperty ("feedbackGuardEnabled", rack.isFeedbackGuardEnabled());
    status->setProperty ("feedbackMuted", rack.isFeedbackMuted());
    status->setProperty ("outputMuted", rack.isUserMuted());

    auto* reading = new juce::DynamicObject();
    reading->setProperty ("detected", tuner.detected);
    if (tuner.detected)
    {
        reading->setProperty ("frequencyHz", tuner.frequencyHz);
        reading->setProperty ("midiNote", tuner.midiNote);
        reading->setProperty ("cents", tuner.cents);
        reading->setProperty ("confidence", tuner.confidence);
    }
    status->setProperty ("tunerReading", juce::var (reading));

    // The looper, like standby, is level-triggered state re-stated every tick:
    // a dropped push must never leave the pedal display wrong.
    const auto looperStatus = rack.getLooperStatus();
    static const char* const looperStateNames[] = { "empty", "armed", "recording", "playing", "overdubbing", "stopped" };
    status->setProperty ("looperState", looperStateNames[(int) looperStatus.state]);
    status->setProperty ("looperLengthSeconds", looperStatus.lengthSeconds);
    status->setProperty ("looperPosition", looperStatus.position);
    status->setProperty ("looperHasUndo", looperStatus.hasUndo);
    status->setProperty ("looperUndoIsRedo", looperStatus.undoIsRedo);
    status->setProperty ("looperPostChain", rack.isLooperPostChain());
    status->setProperty ("looperArmEnabled", rack.isLooperArmEnabled());
    status->setProperty ("looperArmThresholdDb", rack.getLooperArmThresholdDb());

    const auto metronomeStatus = rack.getMetronomeStatus();
    status->setProperty ("metronomeEnabled", rack.isMetronomeEnabled());
    status->setProperty ("metronomeBpm", rack.getMetronomeBpm());
    status->setProperty ("metronomeBeatsPerBar", rack.getMetronomeBeatsPerBar());
    status->setProperty ("metronomeSubdivision", rack.getMetronomeSubdivision());
    // Keep the fast status event scalar-only. JUCE's native-integration event
    // queue may retain the payload after this stack frame, and repeatedly
    // handing it a temporary nested array corrupts the WebView bridge heap.
    // JuceEngine expands this compact wire value back into BeatLevel[].
    status->setProperty ("metronomePattern", plectrify::encodeMetronomePattern (
        rack.getMetronomeBeatPattern(), rack.getMetronomeBeatsPerBar()));
    status->setProperty ("metronomeLevelDb", rack.getMetronomeLevelDb());
    status->setProperty ("metronomeBeat", metronomeStatus.beat);
    status->setProperty ("metronomeBeatPhase", metronomeStatus.beatPhase);

    status->setProperty ("cpuLoad", host.cpuLoad());

    const auto now = juce::Time::getMillisecondCounter();
    if (lastRamPollMs == 0 || now - lastRamPollMs >= 1000)
    {
        cachedProcessRamMb = plectrify::getProcessMemoryMb();
        lastRamPollMs = now;
    }
    status->setProperty ("processRamMb", cachedProcessRamMb);
    status->setProperty ("systemRamTotalMb", systemRamTotalMb);

    // Auto Standby is reported as level-triggered state, re-stated every tick,
    // rather than as enter/exit events: emitEventIfBrowserIsVisible can drop a
    // message, and a dropped edge would leave the UI permanently wrong with
    // nothing to correct it. Echoing the config back gives the UI the same
    // self-healing for its own writes.
    const auto standbyConfig = standby.getConfig();
    status->setProperty ("standbyStage", StandbyController::stageName (standby.getStage()));
    status->setProperty ("standbyIdleSeconds", standby.getIdleSeconds (now));
    status->setProperty ("standbyBlocked", standbyBlocked);
    status->setProperty ("standbyEnabled", standbyConfig.enabled);
    status->setProperty ("standbyLightAfterMinutes", standbyConfig.lightAfterMinutes);
    status->setProperty ("standbyDeepAfterMinutes", standbyConfig.deepAfterMinutes);
    status->setProperty ("standbyWakeThresholdDb", standbyConfig.wakeThresholdDb);
    status->setProperty ("standbyWakeFailures", standbyWakeFailures);

    const auto [sampleRate, bufferSize] = host.currentRateAndBlock();
    status->setProperty ("sampleRate", sampleRate);
    status->setProperty ("bufferSize", bufferSize);

    // Dropouts and how long the app has been up: the two facts that turn "it
    // glitched" into something reproducible. -1 means the driver (or host)
    // cannot count xruns, which the UI shows as unknown rather than as zero.
    status->setProperty ("audioXRuns", host.audioXRuns());
    status->setProperty ("uptimeSeconds", (int) ((now - sessionStartMs) / 1000));

    // Plugin latency the chain adds on top of the driver's own. The graph
    // bakes per-node latency compensation into its render sequence and reports
    // the longest path to the output — the right answer for parallel split
    // lanes (a sum over slots would double-count them), and it includes
    // bypassed nodes, which stay compensated. Constant-time, so no caching.
    const auto chainLatencySamples = rack.getGraph().getLatencySamples();
    status->setProperty ("chainLatencySamples", chainLatencySamples);

    // Round-trip latency is what a player feels: converter/driver input and
    // output latency plus the active plugin chain. Keep it in the live status
    // payload so the compact performance readout needs no separate request.
    auto totalLatency = -1;
    if (const auto deviceLatency = host.deviceLatencySamples(); deviceLatency >= 0)
        totalLatency = deviceLatency + chainLatencySamples;
    status->setProperty ("totalLatencySamples", totalLatency);
    return juce::var (status);
}

void PlectrifyEngine::emitStatusChanged()
{
    emit ("statusChanged", buildStatusState());
}

juce::var PlectrifyEngine::buildPluginsState()
{
    // {id, name, manufacturer, packageId?} per known plugin — the choices the
    // UI's module drawer offers, grouped by manufacturer. `id` is the stable
    // identifier string handed back to `addModule` to instantiate.
    const auto managedDir = PluginManager::getManagedPluginDirectory();
    const auto owners = CatalogueInstaller::installedPluginFileOwners();

    juce::Array<juce::var> plugins;
    for (const auto& desc : pluginManager.getKnownPluginList().getTypes())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty ("id", desc.createIdentifierString());
        p->setProperty ("name", desc.name);
        p->setProperty ("manufacturer", desc.manufacturerName);

        // Which catalogue package installed this plugin, so the UI can file
        // its patches under that package's heading. Joined here rather than in
        // TS because only this side may see paths: the plugin must sit inside
        // the managed directory AND its top-level entry there must be one an
        // install marker recorded — never a bare file-name match, so the
        // user's own copy of the same plugin elsewhere cannot claim a package.
        const juce::File pluginFile (desc.fileOrIdentifier);
        if (pluginFile.isAChildOf (managedDir))
        {
            const auto top = pluginFile.getRelativePathFrom (managedDir)
                                 .upToFirstOccurrenceOf (juce::File::getSeparatorString(), false, false);
            const auto owner = owners.find (top);
            if (owner != owners.end())
                p->setProperty ("packageId", owner->second);
        }

        plugins.add (juce::var (p));
    }
    return plugins;
}

void PlectrifyEngine::emitPluginsChanged()
{
    emit ("pluginsChanged", buildPluginsState());
}

juce::var PlectrifyEngine::buildAppInfoState()
{
    auto* info = new juce::DynamicObject();
    info->setProperty ("version", JUCE_APPLICATION_VERSION_STRING);
    // Which build a report came from matters as much as which version: a Debug
    // run is slower and has assertions the shipped exe does not.
   #if JUCE_DEBUG
    info->setProperty ("build", "Debug");
   #else
    info->setProperty ("build", "Release");
   #endif
    info->setProperty ("os", juce::SystemStats::getOperatingSystemName());
    // A stable discriminator alongside the free-text `os`, so UI wording
    // (Explorer vs Finder, WebView2 vs WebKit, whether ASIO is even a fact
    // worth stating) can branch without parsing a display string.
   #if JUCE_MAC
    info->setProperty ("platform", "macos");
   #else
    info->setProperty ("platform", "windows");
   #endif
    // Which binary this engine is, and which host-owned facilities exist
    // around it — what the page gates its standalone-only surfaces on (the
    // setup wizard, device settings, window chrome, Auto Standby).
    info->setProperty ("host", host.hostKind());
    const auto caps = host.capabilities();
    auto* capabilities = new juce::DynamicObject();
    // Every field, always: the page merges what arrives over the standalone
    // defaults, so a key left out here does not read as "absent, assume
    // standalone" — it reads as false and hides the feature in both builds.
    capabilities->setProperty ("audioDevices", caps.audioDevices);
    capabilities->setProperty ("midiDevices", caps.midiDevices);
    capabilities->setProperty ("windowChrome", caps.windowChrome);
    capabilities->setProperty ("autoStandby", caps.autoStandby);
    capabilities->setProperty ("looper", caps.looper);
    capabilities->setProperty ("metronome", caps.metronome);
    capabilities->setProperty ("feedbackGuard", caps.feedbackGuard);
    info->setProperty ("capabilities", juce::var (capabilities));
    info->setProperty ("juceVersion", juce::SystemStats::getJUCEVersion());

    // --- Provenance: which source this exe is, and what it can host ---------
    const auto& build = plectrify::buildInfo();
    auto* provenance = new juce::DynamicObject();
    provenance->setProperty ("commit", build.commit);
    provenance->setProperty ("dirty", build.dirty);
    provenance->setProperty ("builtAt", build.builtAt);
    provenance->setProperty ("compiler", build.compiler);
    // Whether ASIO made it into this binary is a build-time fact the user
    // cannot see anywhere else, and it explains a missing device type.
   #if JUCE_ASIO
    provenance->setProperty ("asio", true);
   #else
    provenance->setProperty ("asio", false);
   #endif
    provenance->setProperty ("vst3", JUCE_PLUGINHOST_VST3 != 0);
    info->setProperty ("buildInfo", juce::var (provenance));

    // --- The machine ------------------------------------------------------
    // Deliberately no computer name, logon name or file paths: this block is
    // written to be pasted into a public issue, and Windows paths carry the
    // user's account name.
    auto* system = new juce::DynamicObject();
    system->setProperty ("os64Bit", juce::SystemStats::isOperatingSystem64Bit());
    system->setProperty ("cpuModel", juce::SystemStats::getCpuModel());
    system->setProperty ("cpuVendor", juce::SystemStats::getCpuVendor());
    system->setProperty ("cpuSpeedMhz", juce::SystemStats::getCpuSpeedInMegahertz());
    system->setProperty ("cpuCores", juce::SystemStats::getNumCpus());
    system->setProperty ("cpuPhysicalCores", juce::SystemStats::getNumPhysicalCpus());
    system->setProperty ("ramTotalMb", systemRamTotalMb);
    system->setProperty ("language", juce::SystemStats::getUserLanguage());
    system->setProperty ("region", juce::SystemStats::getUserRegion());

    const auto& displays = juce::Desktop::getInstance().getDisplays();
    if (auto* primary = displays.getPrimaryDisplay())
    {
        // Physical pixels, with `scale` alongside: together they say both what
        // the panel is and how much the OS is magnifying the UI on it.
        system->setProperty ("displayWidth", primary->physicalBounds.getWidth());
        system->setProperty ("displayHeight", primary->physicalBounds.getHeight());
        system->setProperty ("displayScale", primary->scale);
    }
    system->setProperty ("displayCount", displays.displays.size());
    info->setProperty ("system", juce::var (system));

    // --- The audio device -------------------------------------------------
    // Rate and buffer stay in the live status payload rather than being
    // duplicated here, so the report has exactly one source for each number.
    // Void when no device is open: the group is then absent and the report
    // dashes those rows out, rather than reporting a device that isn't.
    if (const auto audio = host.audioDeviceInfo(); ! audio.isVoid())
        info->setProperty ("audio", audio);

    auto* plugins = new juce::DynamicObject();
    plugins->setProperty ("known", pluginManager.getKnownPluginList().getNumTypes());
    // Count only — every blacklist entry is a path under the user's home.
    plugins->setProperty ("blacklisted", pluginManager.getKnownPluginList().getBlacklistedFiles().size());
    info->setProperty ("plugins", juce::var (plugins));

    return juce::var (info);
}

void PlectrifyEngine::emitAppInfo()
{
    emit ("appInfo", buildAppInfoState());
}

void PlectrifyEngine::emitMidiDevices()
{
    if (webView == nullptr)
        return;

    auto* state = new juce::DynamicObject();
    juce::Array<juce::var> devices;

    for (const auto& name : host.midiDeviceNames())
        devices.add (name);

    state->setProperty ("devices", juce::var (std::move (devices)));
    emit ("midiDevicesChanged", juce::var (state));
}

void PlectrifyEngine::emitPluginScanChanged (const juce::String& status)
{
    if (webView == nullptr)
        return;

    auto* state = new juce::DynamicObject();
    state->setProperty ("status", status);
    state->setProperty ("pluginCount", pluginManager.getKnownPluginList().getNumTypes());
    emit ("pluginScanChanged", juce::var (state));
}

juce::var PlectrifyEngine::buildPluginBlacklistState()
{
    juce::Array<juce::var> entries;

    for (const auto& path : pluginManager.getBlacklistedPlugins())
    {
        auto* entry = new juce::DynamicObject();
        entry->setProperty ("path", path);
        // A VST3 is named by its file, not by anything readable inside it: the
        // scan never got far enough to learn the plugin's own name.
        entry->setProperty ("name", juce::File::isAbsolutePath (path)
                                        ? juce::File (path).getFileNameWithoutExtension()
                                        : path);
        entries.add (juce::var (entry));
    }

    return entries;
}

void PlectrifyEngine::emitPluginBlacklist()
{
    emit ("pluginBlacklistChanged", buildPluginBlacklistState());
}

void PlectrifyEngine::handleRetryBlacklistedPlugins (const juce::var& payload)
{
    juce::StringArray paths;
    if (auto* list = payload.getProperty ("paths", {}).getArray())
        for (const auto& path : *list)
            paths.add (path.toString());
    // An absent or empty list means every blacklisted file — see unblacklistPlugins.

    const bool cleared = pluginManager.unblacklistPlugins (paths) > 0;

    // Even when nothing was cleared: the UI's copy of the list was stale (or a
    // scan refused the retry), and this corrects it.
    emitPluginBlacklist();

    if (! cleared)
        return;

    emitAppInfo();      // the blacklisted count moved
    scanForPlugins();   // retried plugins only reappear once they are scanned
}

// --- Plugin catalogue ------------------------------------------------------

juce::var PlectrifyEngine::buildCatalogueState()
{
    // One list, plugins and content alike, in the catalogue's order. `category`
    // is the heading path the panel groups by and `tags` the chips it filters
    // by — both the catalogue's own words; `kind` travels for completeness
    // but the UI has no business branching on it — where a payload lands was
    // settled by the installer long before this state is built.
    juce::Array<juce::var> items;

    for (const auto& item : catalogue.getItems())
    {
        const auto& package = item.package;

        auto* entry = new juce::DynamicObject();
        entry->setProperty ("id", package.id);
        entry->setProperty ("kind", package.isContent() ? "content" : "plugin");
        entry->setProperty ("category", plectrify::toVarArray (package.category));
        entry->setProperty ("tags", plectrify::toVarArray (package.tags));
        entry->setProperty ("name", package.name);
        entry->setProperty ("purpose", package.purpose);
        entry->setProperty ("version", package.version);
        entry->setProperty ("licenseId", package.licenseId);
        entry->setProperty ("licenseUrl", package.licenseUrl);
        // Content entries often name their source rather than a project page;
        // either way the panel shows one "Project" link, so fall back.
        entry->setProperty ("projectUrl", package.projectUrl.isNotEmpty() ? package.projectUrl
                                                                          : package.sourceUrl);
        // Whether Install can do anything here, and how big the payload is. The
        // engine answers rather than shipping platform slugs to the page: the UI
        // only needs that verdict, never which OS it is serving. The verdict
        // covers the dependency chain as well as this package's own asset (see
        // Item::available), so the row's own asset is read here only for what it
        // says about itself.
        const auto asset = package.assetFor (catalogueRuntimePlatform);
        entry->setProperty ("available", item.available);
        // Zero for a package this platform is not offered: there is no size to
        // quote for a download that cannot happen, and the panel already omits
        // the figure when it is zero.
        entry->setProperty ("downloadBytes", asset ? asset->downloadBytes : juce::int64 { 0 });
        // Who serves the payload THIS machine would get. A package can be a
        // mirror of the project's own build on one platform and a copy Plectrify
        // hosts on the other, so the answer is the asset's, not the package's.
        // False where there is no asset at all: nobody is serving anything.
        entry->setProperty ("selfHosted", asset && asset->selfHosted);
        // What installing this row will bring with it. The installer resolves
        // this itself, so the panel needs it only to say so beforehand —
        // clicking Install on a patch and silently fetching a plugin as well
        // would be the panel keeping something from the user.
        entry->setProperty ("dependsOn", package.dependsOn);
        entry->setProperty ("installed", item.installed);
        entry->setProperty ("installedVersion", item.installedVersion);
        entry->setProperty ("updateAvailable", item.updateAvailable);
        entry->setProperty ("unlisted", item.unlisted);
        // Only content has a folder of its own worth naming; a plugin's is the
        // managed VST3 directory the panel already reports once.
        entry->setProperty ("dir",
                            package.isContent()
                                ? CatalogueInstaller::contentDirectory (package.installDir)
                                      .getFullPathName()
                                : juce::String());
        items.add (juce::var (entry));
    }

    // Bundles hold only package IDs, so the panel renders them from the rows
    // above rather than from a second copy of the package data.
    juce::Array<juce::var> bundles;

    for (const auto& bundle : catalogue.getBundles())
    {
        juce::Array<juce::var> packageIds, missing, outdated;
        for (const auto& id : bundle.bundle.packageIds) packageIds.add (id);
        for (const auto& id : bundle.missingPackageIds) missing.add (id);
        for (const auto& id : bundle.outdatedPackageIds) outdated.add (id);

        auto* entry = new juce::DynamicObject();
        entry->setProperty ("id", bundle.bundle.id);
        entry->setProperty ("name", bundle.bundle.name);
        entry->setProperty ("description", bundle.bundle.description);
        entry->setProperty ("version", bundle.bundle.version);
        entry->setProperty ("packageIds", packageIds);
        entry->setProperty ("missingPackageIds", missing);
        entry->setProperty ("outdatedPackageIds", outdated);
        entry->setProperty ("installedVersion", bundle.installedVersion);
        entry->setProperty ("installed", bundle.isFullyInstalled());
        entry->setProperty ("updateAvailable", bundle.updateAvailable());
        bundles.add (juce::var (entry));
    }

    // Licence disclosure rides with the catalogue rather than shipping in the
    // installer, so changing the offered packages changes their notices in the
    // same step instead of leaving a stale file on disk.
    const auto notices = catalogue.getNotices();
    auto* noticeText = new juce::DynamicObject();
    noticeText->setProperty ("summary", notices.summary);
    noticeText->setProperty ("fetched", notices.fetched);
    noticeText->setProperty ("hosted", notices.hosted);
    noticeText->setProperty ("models", notices.models);
    noticeText->setProperty ("uninstall", notices.uninstall);

    // Where to get what Plectrify does not host. It ships no amp captures or IRs,
    // so once the plugins are installed these links are the rest of the answer.
    // The category rides along untouched — the panel groups and titles itself
    // from it, so a new kind of download is a catalogue publish, not a release.
    juce::Array<juce::var> links;
    for (const auto& link : catalogue.getLinks())
    {
        auto* entry = new juce::DynamicObject();
        entry->setProperty ("category", plectrify::toVarArray (link.category));
        entry->setProperty ("tags", plectrify::toVarArray (link.tags));
        entry->setProperty ("label", link.label);
        entry->setProperty ("url", link.url);
        entry->setProperty ("note", link.note);
        links.add (juce::var (entry));
    }

    auto* state = new juce::DynamicObject();
    state->setProperty ("items", items);
    state->setProperty ("bundles", bundles);
    state->setProperty ("links", links);
    state->setProperty ("notices", juce::var (noticeText));
    state->setProperty ("busy", catalogue.isRunning());
    state->setProperty ("dir", CatalogueInstaller::installDirectory().getFullPathName());
    // The panel says out loud when the list is not the published one, so a
    // cached catalogue is never mistaken for current.
    state->setProperty ("source", toString (catalogue.getCatalogueSource()));
    state->setProperty ("error", catalogue.getCatalogueError());
    return juce::var (state);
}

void PlectrifyEngine::emitCatalogueState()
{
    emit ("catalogueState", buildCatalogueState());
}

void PlectrifyEngine::handleRequestCatalogue (const juce::var& payload)
{
    // Answer immediately with what we already know, so opening the panel is
    // never a blank wait, then refresh and answer again.
    emitCatalogueState();

    const bool refresh = payload.getProperty ("refresh", true);
    if (! refresh)
        return;

    juce::WeakReference<PlectrifyEngine> safe (this);
    catalogue.refreshCatalogueAsync ([safe]
    {
        if (safe != nullptr)
            safe->emitCatalogueState();
    });
}

void PlectrifyEngine::handleInstallPackages (const juce::var& payload)
{
    juce::StringArray ids;
    if (auto* list = payload.getProperty ("ids", {}).getArray())
        for (const auto& id : *list)
            ids.add (id.toString());

    const auto requestId = payload.getProperty ("requestId", {}).toString();
    // Set when the run came from a bundle's own button, so the bundle's installed
    // edition can be recorded once every plugin in it landed. Absent for
    // individual plugin installs, which say nothing about any bundle.
    const auto bundleId = payload.getProperty ("bundleId", {}).toString();
    // Set by the first-run starter install alone: that run happens on a machine
    // that has never been scanned, so it ends with a walk of the whole search
    // path rather than of the folder it wrote to — the plugins the user already
    // had would otherwise stay invisible until they pressed Rescan. Every other
    // install keeps the narrow scan; see scanManagedPlugins.
    const bool rescanAll = payload.getProperty ("rescanAll", false);

    if (ids.isEmpty())
        return;

    juce::WeakReference<PlectrifyEngine> safe (this);

    const auto onProgress = [safe, requestId] (CatalogueInstaller::Progress p)
    {
        if (safe == nullptr)
            return;

        auto* event = new juce::DynamicObject();
        event->setProperty ("requestId", requestId);
        event->setProperty ("id", p.id);
        event->setProperty ("name", p.name);
        event->setProperty ("index", p.index);
        event->setProperty ("count", p.count);
        event->setProperty ("received", p.received);
        event->setProperty ("total", p.total);
        event->setProperty ("error", p.error);

        const auto stage = [&]
        {
            switch (p.stage)
            {
                case CatalogueInstaller::Stage::queued:      return "queued";
                case CatalogueInstaller::Stage::downloading: return "downloading";
                case CatalogueInstaller::Stage::verifying:   return "verifying";
                case CatalogueInstaller::Stage::extracting:  return "extracting";
                case CatalogueInstaller::Stage::installing:  return "installing";
                case CatalogueInstaller::Stage::installed:   return "installed";
                case CatalogueInstaller::Stage::skipped:     return "skipped";
                case CatalogueInstaller::Stage::failed:      return "failed";
            }
            return "failed";
        }();
        event->setProperty ("stage", juce::String (stage));

        safe->emit ("installProgress", juce::var (event));
    };

    const auto onFinished = [safe, requestId, bundleId, rescanAll] (CatalogueInstaller::Result result)
    {
        if (safe == nullptr)
            return;

        // Record the bundle's edition only when the whole run succeeded. A
        // partial install must not claim the user has that bundle version, or
        // the next catalogue bump would show no update and quietly leave them
        // short a plugin.
        if (bundleId.isNotEmpty() && result.failed.empty() && ! result.cancelled)
            safe->catalogue.noteBundleInstalled (bundleId);

        juce::Array<juce::var> installed, skipped, failed;
        for (const auto& id : result.installed) installed.add (id);
        for (const auto& id : result.skipped)   skipped.add (id);

        for (const auto& [id, error] : result.failed)
        {
            auto* entry = new juce::DynamicObject();
            entry->setProperty ("id", id);
            entry->setProperty ("error", error);
            failed.add (juce::var (entry));
        }

        auto* event = new juce::DynamicObject();
        event->setProperty ("requestId", requestId);
        event->setProperty ("ok", result.failed.empty() && ! result.cancelled);
        event->setProperty ("installed", installed);
        event->setProperty ("skipped", skipped);
        event->setProperty ("failed", failed);
        event->setProperty ("cancelled", result.cancelled);
        safe->emit ("installFinished", juce::var (event));

        // The finish event rides emitEventIfBrowserIsVisible and can be
        // dropped if the window is occluded — likely across a long download.
        // Pushing the state too means the panel reconciles from disk truth
        // rather than depending on the stream having arrived intact.
        safe->emitCatalogueState();

        // Newly installed plugins only appear in the picker once scanned, and
        // the installer writes to one folder, so that folder is all this reads.
        // The first run is the exception: it scans everywhere, and does so even
        // when nothing was installed — the machine has never been scanned, so
        // the walk is worth making whatever the download did.
        if (rescanAll)
            safe->requestFullRescan();
        else if (! result.installed.isEmpty())
            safe->scanManagedPlugins();
    };

    if (! catalogue.installAsync (ids, onProgress, onFinished))
    {
        auto* event = new juce::DynamicObject();
        event->setProperty ("requestId", requestId);
        event->setProperty ("ok", false);
        event->setProperty ("error", "busy");
        emit ("installFinished", juce::var (event));
        return;
    }

    emitCatalogueState();   // busy = true
}

void PlectrifyEngine::handleCancelInstall (const juce::var&)
{
    catalogue.cancel();
}

void PlectrifyEngine::handleUninstallPackages (const juce::var& payload)
{
    juce::StringArray ids;
    if (auto* list = payload.getProperty ("ids", {}).getArray())
        for (const auto& id : *list)
            ids.add (id.toString());

    if (ids.isEmpty())
        return;

    const auto requestId = payload.getProperty ("requestId", {}).toString();
    juce::WeakReference<PlectrifyEngine> safe (this);

    const auto onFinished = [safe, requestId] (CatalogueInstaller::Result result)
    {
        if (safe == nullptr)
            return;

        juce::Array<juce::var> removed, failed;
        for (const auto& id : result.removed)
            removed.add (id);

        for (const auto& [id, error] : result.failed)
        {
            auto* entry = new juce::DynamicObject();
            entry->setProperty ("id", id);
            entry->setProperty ("error", error);
            failed.add (juce::var (entry));
        }

        auto* event = new juce::DynamicObject();
        event->setProperty ("requestId", requestId);
        event->setProperty ("ok", result.failed.empty());
        event->setProperty ("installed", juce::Array<juce::var>());
        event->setProperty ("skipped", juce::Array<juce::var>());
        event->setProperty ("removed", removed);
        event->setProperty ("failed", failed);
        event->setProperty ("cancelled", false);

        safe->emit ("installFinished", juce::var (event));

        safe->emitCatalogueState();

        // The removed plugins are still in the known-plugins list until a scan
        // prunes the entries whose files are gone, so the picker would keep
        // offering plugins that can no longer be instantiated. Pruning is not
        // limited to what a scan walks, so the managed directory is enough.
        if (! result.removed.isEmpty())
            safe->scanManagedPlugins();
    };

    if (! catalogue.uninstallAsync (ids, onFinished))
    {
        auto* event = new juce::DynamicObject();
        event->setProperty ("requestId", requestId);
        event->setProperty ("ok", false);
        event->setProperty ("error", "busy");
        emit ("installFinished", juce::var (event));
        return;
    }

    emitCatalogueState();
}

void PlectrifyEngine::timerCallback()
{
    // Everything up to the view guard below is real engine work, not UI
    // traffic, and must run with no page attached: the plugin build ticks
    // headless between editor opens, and its host's delay compensation (and a
    // pending looper load) cannot wait for a window.
    if (graphLatencyDirty.exchange (false, std::memory_order_acq_rel))
        rack.refreshLatencyCompensation();

    // Published on a diff every tick rather than from the dirty flag alone:
    // topology edits change the chain's latency too, and the graph re-bakes
    // its render sequence asynchronously, so the settled figure is only
    // observable by looking again. The standalone's host ignores it (the
    // figure already rides the status payload); the plugin reports it upward
    // so the DAW's delay compensation tracks the chain.
    if (const auto latency = rack.getGraph().getLatencySamples(); latency != lastPublishedLatency)
    {
        lastPublishedLatency = latency;
        host.graphLatencyChanged (latency);
    }

    // The host-state capture cache, for hosts that persist the engine's state
    // in their own project (the VST3). Rate-limited inside; a plain no-op in
    // the standalone.
    if (host.capturesHostState())
        refreshHostStateCacheIfDue();

    // A session load completes when the audio thread adopts the staged buffer;
    // a stopped device would never adopt, so the wait is bounded rather than
    // leaving the one-load-at-a-time latch stuck forever.
    if (looperLoadInFlight)
    {
        if (looperLoadStaged && rack.isLooperLoadConsumed())
        {
            looperLoadInFlight = false;
            emitLooperSessionLoaded (pendingLooperLoadRequestId, true);
        }
        else if (juce::Time::getMillisecondCounter() - looperLoadStartMs > 10000)
        {
            looperLoadInFlight = false;
            emitLooperSessionLoaded (pendingLooperLoadRequestId, false);
        }
    }

    // The standby meter is consumed every tick even when the feature is off
    // (or the host owns suspension): it is max-hold, so leaving it to
    // accumulate would fire a spurious wake the moment standby is enabled.
    StandbyController::Tick standbyTick;
    standbyTick.nowMs      = juce::Time::getMillisecondCounter();
    standbyTick.inputPeak  = rack.consumeStandbyInputPeak();
    standbyTick.blocked    = standbyIsBlocked();
    standbyTick.hasPlugins = ! rack.getSlots().empty();
    standbyBlocked = standbyTick.blocked;
    if (host.capabilities().autoStandby)
        standby.tick (standbyTick);

    // Above the guard because the plugin's implementation is the *only* drain of
    // its host-MIDI FIFO: left below, a closed editor lets the queue fill and
    // then silently drop, and reopening hands the page a batch of presses the
    // player made minutes ago. Draining regardless discards them where they are
    // meant to be discarded — emit() no-ops with no view. (MIDI still acts on
    // nothing while detached: the bindings are dispatched by the page. See the
    // headless-MIDI item in TODO.md.) The standalone's implementation emits the
    // setup wizard's input meters, which no-op the same way.
    host.onEngineTick();

    if (webView == nullptr)
        return;

    const bool paramsChanged = pluginParamsChanged.exchange (false, std::memory_order_acq_rel);
    const bool stateChanged  = pluginInternalStateChanged.exchange (false, std::memory_order_acq_rel);
    if (paramsChanged || stateChanged)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("params", paramsChanged);
        o->setProperty ("state", stateChanged);
        emit ("pluginStateChanged", juce::var (o));
    }

    emitStatusChanged();

    juce::Array<juce::var> modules;
    for (const auto& slot : rack.getSlots())
    {
        auto* inst = rack.getPluginInstance (slot.nodeID);
        if (inst == nullptr)
            continue;

        const auto watched = watchedParams.find (slot.clientId);
        if (watched == watchedParams.end() || watched->second.empty())
            continue;

        const auto& params = inst->getParameters();
        juce::Array<juce::var> values;
        for (const int paramIndex : watched->second)
        {
            if (paramIndex < 0 || paramIndex >= params.size())
                continue;

            auto* p  = params[paramIndex];
            auto* vo = new juce::DynamicObject();
            vo->setProperty ("paramIndex", paramIndex);
            vo->setProperty ("value", (double) p->getValue());
            vo->setProperty ("text", p->getCurrentValueAsText());
            values.add (juce::var (vo));
        }

        auto* mo = new juce::DynamicObject();
        mo->setProperty ("id", slot.clientId);
        mo->setProperty ("params", values);
        modules.add (juce::var (mo));
    }
    emit ("paramValues", modules);
}

void PlectrifyEngine::audioProcessorParameterChanged (juce::AudioProcessor*, int, float)
{
    pluginParamsChanged.store (true, std::memory_order_release);
    markHostStateDirty();
}

void PlectrifyEngine::audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails& details)
{
    if (details.programChanged || details.nonParameterStateChanged)
    {
        pluginInternalStateChanged.store (true, std::memory_order_release);
        markHostStateDirty();
    }

    // The graph bakes per-node latency compensation into its render sequence,
    // so a plugin changing latency (e.g. oversampling toggled in its editor)
    // needs a rebuild — deferred to the timer; this may be the audio thread.
    if (details.latencyChanged)
        graphLatencyDirty.store (true, std::memory_order_release);
}

// ---------------------------------------------------------------------------
// JS -> C++ handlers.
// ---------------------------------------------------------------------------
std::optional<juce::AudioProcessorGraph::NodeID>
    PlectrifyEngine::findNode (const juce::String& moduleId) const
{
    for (const auto& slot : rack.getSlots())
        if (slot.clientId == moduleId)
            return slot.nodeID;
    return std::nullopt;
}

void PlectrifyEngine::handleInsertModule (const juce::var& payload)
{
    // The UI drives plugin choice through its own picker, so we create the
    // chosen plugin directly — no native menu. TS mints the clientId; it rides
    // along so the created slot carries the id the UI already knows.
    const auto clientId = payload["clientId"].toString();
    const auto pluginId = payload["pluginId"].toString();
    const auto laneId = payload["laneId"].toString();
    const auto beforeModuleId = payload["beforeModuleId"].toString();

    int index = (int) rack.getSlots().size();
    std::optional<int> serialPosition;
    if (laneId.isNotEmpty())
    {
        const auto& slots = rack.getSlots();
        for (int i = 0; i < (int) slots.size(); ++i)
            if (slots[(size_t) i].clientId == beforeModuleId
                && slots[(size_t) i].laneId == laneId)
            {
                index = i;
                break;
            }
    }
    else
    {
        const int requestedPosition = juce::jmax (0, (int) payload["serialPosition"]);
        serialPosition = requestedPosition;
        int currentPosition = 0;
        const auto& slots = rack.getSlots();
        for (int i = 0; i < (int) slots.size(); ++i)
            if (slots[(size_t) i].laneId.isEmpty())
            {
                if (currentPosition == requestedPosition)
                {
                    index = i;
                    break;
                }
                ++currentPosition;
            }
    }

    // Absent means "open it": only the patch path asks for the editor to stay
    // shut, and an older page that doesn't send the flag wants the old default.
    const bool openEditor = ! payload.hasProperty ("openEditor")
                            || (bool) payload["openEditor"];

    if (const auto desc = findKnownPlugin (pluginId))
        addPluginFromDescription (*desc, index, clientId, laneId, serialPosition,
                                  payload["beforeGroupId"].toString(), openEditor);
    else
        juce::AlertWindow::showMessageBoxAsync (
            juce::AlertWindow::WarningIcon, "Could not add plugin",
            "The selected plugin is no longer in the scanned list. Rescan and try again.");
}

void PlectrifyEngine::handleReplaceModule (const juce::var& payload)
{
    // Dropping a drawer tile onto a module rather than into a gap: the plugin
    // behind that module is swapped for another, keeping its place in the
    // chain. The old module's identity goes with it — TS mints a fresh
    // clientId, so its knob mapping, name, colour and MIDI bindings do not
    // outlive the plugin whose parameters they named.
    const auto oldId    = payload["id"].toString();
    const auto clientId = payload["clientId"].toString();
    const auto pluginId = payload["pluginId"].toString();
    const bool openEditor = ! payload.hasProperty ("openEditor")
                            || (bool) payload["openEditor"];

    const auto desc = findKnownPlugin (pluginId);
    if (! desc.has_value())
    {
        juce::AlertWindow::showMessageBoxAsync (
            juce::AlertWindow::WarningIcon, "Could not add plugin",
            "The selected plugin is no longer in the scanned list. Rescan and try again.");
        return;
    }

    if (! findNode (oldId).has_value())
        return;

    const auto [sampleRate, blockSize] = host.currentRateAndBlock();
    const int generation = rigLoadGeneration;
    juce::WeakReference<PlectrifyEngine> safe (this);

    // Create first, drop the old module second. Three things follow, and all
    // three are the reason this is one handler rather than a remove and an
    // insert from the page: a plugin that fails to load leaves the rack
    // exactly as it was, no rackChanged ever describes a rack with a hole
    // where the module was, and a lane whose only module is being replaced is
    // never momentarily emptied — which would collapse the lane, and with a
    // two-lane split, the whole split.
    pluginManager.createInstanceAsync (*desc, sampleRate, blockSize,
        [safe, generation, oldId, clientId, openEditor]
        (std::unique_ptr<juce::AudioPluginInstance> instance, const juce::String& error)
        {
            if (safe == nullptr || ! safe->ownsRack (generation))
                return; // shutting down, or the rack this targets is gone; discard

            if (instance == nullptr)
            {
                juce::AlertWindow::showMessageBoxAsync (
                    juce::AlertWindow::WarningIcon, "Could not load plugin",
                    error.isNotEmpty() ? error : "Unknown error");
                return;
            }

            // The rack is re-read here, not captured above: the load ran on
            // another thread and anything could have moved the module since.
            const auto& slots = safe->rack.getSlots();
            int index = -1;
            for (int i = 0; i < (int) slots.size(); ++i)
                if (slots[(size_t) i].clientId == oldId)
                {
                    index = i;
                    break;
                }

            if (index < 0)
                return; // the module being replaced is gone; nothing to stand in for

            const auto laneId = slots[(size_t) index].laneId;
            const auto oldNode = slots[(size_t) index].nodeID;

            // Inserting at the old module's own index puts the replacement
            // immediately before it — in its lane once movePluginToLane has
            // run, or in the serial chain, where `serialPosition` advances the
            // splits after that gap by one. Removing the old module pulls them
            // straight back, so the split structure is unchanged overall.
            std::optional<int> serialPosition;
            if (laneId.isEmpty())
                serialPosition = (int) std::count_if (slots.begin(), slots.begin() + index,
                    [] (const RackProcessor::Slot& slot) { return slot.laneId.isEmpty(); });

            const auto nodeID = safe->rack.addPlugin (std::move (instance), index, clientId,
                                                      serialPosition);
            if (auto* added = safe->rack.getPluginInstance (nodeID))
                added->addListener (safe.get());
            if (laneId.isNotEmpty())
                safe->rack.movePluginToLane (clientId, laneId);

            safe->editorWindows.erase (oldNode.uid);
            if (auto* outgoing = safe->rack.getPluginInstance (oldNode))
                outgoing->removeListener (safe.get());
            safe->rack.removePlugin (oldNode);

            safe->emitRackChanged();
            if (openEditor)
                safe->openEditorFor (nodeID);
        });
}

void PlectrifyEngine::handleRemoveModule (const juce::var& payload)
{
    if (auto node = findNode (payload["id"].toString()))
    {
        editorWindows.erase (node->uid);
        if (auto* instance = rack.getPluginInstance (*node))
            instance->removeListener (this);
        rack.removePlugin (*node);
        emitRackChanged();
    }
}

void PlectrifyEngine::handleReorder (const juce::var& payload)
{
    const auto id = payload["id"].toString();
    const int toIndex = (int) payload["toIndex"];

    const auto& slots = rack.getSlots();
    for (int i = 0; i < (int) slots.size(); ++i)
        if (slots[(size_t) i].clientId == id)
        {
            rack.movePlugin (i, toIndex);
            emitRackChanged();
            return;
        }
}

void PlectrifyEngine::handleMoveModule (const juce::var& payload)
{
    // A dumb parser: the coordinate resolution lives in RackProcessor::moveSlot
    // so the headless tests can cover it. `serialPosition` must survive as
    // "absent" (a lane move) — hence the hasProperty check, like handleSetLaneMix.
    RackProcessor::MoveTarget target;
    target.laneId         = payload["laneId"].toString();
    target.beforeModuleId = payload["beforeModuleId"].toString();
    target.beforeGroupId  = payload["beforeGroupId"].toString();
    target.newLaneGroupId = payload["newLaneGroupId"].toString();
    target.newLaneId      = payload["newLaneId"].toString();
    if (auto* object = payload.getDynamicObject(); object != nullptr && object->hasProperty ("serialPosition"))
        target.serialPosition = (int) payload["serialPosition"];

    rack.moveSlot (payload["id"].toString(), target);
    emitRackChanged();
}

void PlectrifyEngine::handleSwapModules (const juce::var& payload)
{
    // Both modules keep their ids and their plugin instances, so no editor
    // window, listener or pending state has anything to re-point: the two only
    // change places in the chain.
    rack.swapSlots (payload["a"].toString(), payload["b"].toString());
    emitRackChanged();
}

void PlectrifyEngine::handleSetBypass (const juce::var& payload)
{
    if (auto node = findNode (payload["id"].toString()))
    {
        rack.setBypassed (*node, (bool) payload["bypassed"]);
        emitRackChanged();
    }
}

void PlectrifyEngine::handleSetParam (const juce::var& payload)
{
    auto node = findNode (payload["moduleId"].toString());
    if (! node)
        return;

    if (auto* inst = rack.getPluginInstance (*node))
    {
        const int idx = (int) payload["paramIndex"];
        const auto& params = inst->getParameters();
        if (idx >= 0 && idx < params.size())
            params[idx]->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, (float) (double) payload["value"]));
    }
}

void PlectrifyEngine::handleSetParams (const juce::var& payload)
{
    // Batched setParam: {modules: [{id, params: [{paramIndex, value}]}]}. One
    // node lookup per module; each write is the same real-time-safe
    // setValueNotifyingHost as a single setParam, so a scene switch applies
    // every value without touching the graph.
    auto* modules = payload["modules"].getArray();
    if (modules == nullptr)
        return;

    for (const auto& m : *modules)
    {
        auto node = findNode (m["id"].toString());
        if (! node)
            continue;

        auto* inst = rack.getPluginInstance (*node);
        if (inst == nullptr)
            continue;

        const auto& params = inst->getParameters();
        if (auto* entries = m["params"].getArray())
            for (const auto& entry : *entries)
            {
                const int idx = (int) entry["paramIndex"];
                if (idx >= 0 && idx < params.size())
                    params[idx]->setValueNotifyingHost (
                        juce::jlimit (0.0f, 1.0f, (float) (double) entry["value"]));
            }
    }
}

void PlectrifyEngine::handleSetBypassStates (const juce::var& payload)
{
    // Batched setBypass: {modules: [{id, bypassed}]}. One revision bump and
    // one rackChanged echo for the whole batch; the bypass flips themselves
    // are per-node atomics, so nothing here interrupts audio.
    auto* modules = payload["modules"].getArray();
    if (modules == nullptr)
        return;

    std::vector<std::pair<juce::String, bool>> entries;
    entries.reserve ((size_t) modules->size());
    for (const auto& m : *modules)
        entries.emplace_back (m["id"].toString(), (bool) m["bypassed"]);

    if (rack.setBypassedBatch (entries))
        emitRackChanged();
}

void PlectrifyEngine::handleWatchParams (const juce::var& payload)
{
    // Replace the whole watch set: TS re-sends it whenever a mapping changes.
    watchedParams.clear();
    if (auto* modules = payload["modules"].getArray())
        for (const auto& m : *modules)
        {
            std::vector<int> indices;
            if (auto* idx = m["paramIndexes"].getArray())
                for (const auto& i : *idx)
                    indices.push_back ((int) i);
            watchedParams[m["id"].toString()] = std::move (indices);
        }

    emitParamTexts();
}

void PlectrifyEngine::emitParamTexts()
{
    // A value→text table per watched param: getText sampled across the
    // normalised range. The UI indexes it with the knob value while dragging,
    // so the readout tracks the gesture instead of the 15 Hz value stream.
    if (webView == nullptr)
        return;

    constexpr int samples = 256; // 257 entries — finer than a 150 px drag can resolve

    juce::Array<juce::var> modules;
    for (const auto& slot : rack.getSlots())
    {
        auto* inst = rack.getPluginInstance (slot.nodeID);
        if (inst == nullptr)
            continue;

        const auto watched = watchedParams.find (slot.clientId);
        if (watched == watchedParams.end() || watched->second.empty())
            continue;

        const auto& params = inst->getParameters();
        juce::Array<juce::var> tables;
        for (const int paramIndex : watched->second)
        {
            if (paramIndex < 0 || paramIndex >= params.size())
                continue;

            auto* p = params[paramIndex];
            // Meters and other read-only readouts have no value→text mapping
            // worth caching; their text streams live via paramValues.
            if (! p->isAutomatable())
                continue;

            juce::Array<juce::var> texts;
            for (int sample = 0; sample <= samples; ++sample)
                texts.add (p->getText ((float) sample / (float) samples, 64));

            auto* to = new juce::DynamicObject();
            to->setProperty ("paramIndex", paramIndex);
            to->setProperty ("texts", texts);
            tables.add (juce::var (to));
        }

        if (tables.isEmpty())
            continue;

        auto* mo = new juce::DynamicObject();
        mo->setProperty ("id", slot.clientId);
        mo->setProperty ("params", tables);
        modules.add (juce::var (mo));
    }
    emit ("paramTexts", modules);
}

void PlectrifyEngine::handleOpenEditor (const juce::var& payload)
{
    if (auto node = findNode (payload["id"].toString()))
        openEditorFor (*node);
}

void PlectrifyEngine::handleCreateSplit (const juce::var& payload)
{
    juce::StringArray laneIds;
    if (auto* ids = payload["laneIds"].getArray())
        for (const auto& id : *ids)
            laneIds.add (id.toString());
    rack.createSplit (payload["groupId"].toString(), payload["atModuleId"].toString(), (int) payload["groupPosition"],
                      laneIds, payload["activeLaneId"].toString());
    emitRackChanged();
}

void PlectrifyEngine::handleAddLane (const juce::var& payload)
{
    // The lane arrives empty: it is a routing change only, so an unknown group
    // is simply ignored — the next rackChanged echo re-states the truth.
    rack.addLane (payload["groupId"].toString(), payload["laneId"].toString());
    emitRackChanged();
}

void PlectrifyEngine::handleRemoveLane (const juce::var& payload)
{
    const auto laneId = payload["laneId"].toString();
    // The lane's modules are removed with it, so close their editor windows
    // and detach parameter listeners first, exactly as handleRemoveModule does
    // for a single module.
    for (const auto& slot : rack.getSlots())
        if (slot.laneId == laneId)
        {
            editorWindows.erase (slot.nodeID.uid);
            if (auto* instance = rack.getPluginInstance (slot.nodeID))
                instance->removeListener (this);
        }
    rack.removeLane (laneId);
    emitRackChanged();
}

void PlectrifyEngine::handleMoveLane (const juce::var& payload)
{
    rack.moveLane (payload["laneId"].toString(), (int) payload["toIndex"]);
    emitRackChanged();
}

void PlectrifyEngine::handleSetLaneMix (const juce::var& payload)
{
    auto* object = payload.getDynamicObject();
    if (object == nullptr)
        return;
    const auto optionalFloat = [object] (const juce::Identifier& name) -> std::optional<float>
    {
        return object->hasProperty (name) ? std::optional<float> ((float) (double) object->getProperty (name))
                                          : std::nullopt;
    };
    const auto optionalBool = [object] (const juce::Identifier& name) -> std::optional<bool>
    {
        return object->hasProperty (name) ? std::optional<bool> ((bool) object->getProperty (name))
                                          : std::nullopt;
    };
    rack.setLaneMix (payload["laneId"].toString(), optionalFloat ("gain"), optionalFloat ("pan"),
                     optionalBool ("muted"), optionalBool ("soloed"));
    // Lane mix writes are atomic and the UI applies them optimistically. A full
    // rack snapshot for every fader tick would flood the message thread.
}

void PlectrifyEngine::handleSetLaneSwitch (const juce::var& payload)
{
    rack.setLaneSwitch (payload["groupId"].toString(), payload["activeLaneId"].toString());
    emitRackChanged();
}

void PlectrifyEngine::handleSetStatus (const juce::var& payload)
{
    auto* object = payload.getDynamicObject();
    if (object == nullptr)
        return;
    if (object->hasProperty ("inputGainDb"))
        rack.setInputGainDb ((float) (double) payload["inputGainDb"]);
    if (object->hasProperty ("outputGainDb"))
        rack.setOutputGainDb ((float) (double) payload["outputGainDb"]);
    if (object->hasProperty ("tunerEnabled"))
        rack.setTunerEnabled ((bool) payload["tunerEnabled"]);
    if (object->hasProperty ("midiTunerActive"))
        rack.setMidiTunerActive ((bool) payload["midiTunerActive"]);
    if (object->hasProperty ("feedbackGuardEnabled"))
        rack.setFeedbackGuardEnabled ((bool) payload["feedbackGuardEnabled"]);
    // The page only ever writes false here — clearing the latch is the one half
    // of it the user owns; a deliberate silence is the MUTE button below, which
    // is a reason of its own and survives the guard being disarmed.
    if (object->hasProperty ("feedbackMuted"))
        rack.setFeedbackMuted ((bool) payload["feedbackMuted"]);
    if (object->hasProperty ("outputMuted"))
        rack.setUserMuted ((bool) payload["outputMuted"]);
    if (object->hasProperty ("looperPostChain"))
        rack.setLooperPostChain ((bool) payload["looperPostChain"]);
    if (object->hasProperty ("looperArmEnabled"))
        rack.setLooperArmEnabled ((bool) payload["looperArmEnabled"]);
    if (object->hasProperty ("looperArmThresholdDb"))
        rack.setLooperArmThresholdDb ((float) (double) payload["looperArmThresholdDb"]);
    if (object->hasProperty ("metronomeBpm"))
        rack.setMetronomeBpm ((float) (double) payload["metronomeBpm"]);
    if (object->hasProperty ("metronomeBeatsPerBar"))
        rack.setMetronomeBeatsPerBar ((int) payload["metronomeBeatsPerBar"]);
    if (object->hasProperty ("metronomeSubdivision"))
        rack.setMetronomeSubdivision ((int) payload["metronomeSubdivision"]);
    if (object->hasProperty ("metronomeAccents"))
    {
        auto pattern = rack.getMetronomeBeatPattern();
        if (auto* accents = payload["metronomeAccents"].getArray())
        {
            const int count = juce::jmin (accents->size(), MetronomeProcessor::maxBeatsPerBar);
            for (int beat = 0; beat < count; ++beat)
            {
                const int level = juce::jlimit (0, 3, (int) accents->getReference (beat));
                pattern = MetronomeProcessor::packLevel (
                    pattern, beat, (MetronomeProcessor::BeatLevel) level);
            }
            rack.setMetronomeBeatPattern (pattern);
        }
    }
    if (object->hasProperty ("metronomeLevelDb"))
        rack.setMetronomeLevelDb ((float) (double) payload["metronomeLevelDb"]);
    // The standalone persists these at exit; the plugin's host state carries
    // them and must learn they moved.
    host.engineSettingsChanged();
    emitStatusChanged();
}

void PlectrifyEngine::handleLooperCommand (const juce::var& payload)
{
    const auto action = payload["action"].toString();
    if (action == "toggle")
        rack.looperCommand (LooperProcessor::Command::toggle);
    else if (action == "stop")
        rack.looperCommand (LooperProcessor::Command::stop);
    else if (action == "clear")
    {
        // Archive first: the clear cannot reach the audio thread before the
        // next block, so the loop is still intact while we copy it out.
        saveLooperSessionBeforeClear();
        rack.looperCommand (LooperProcessor::Command::clear);
    }
    else if (action == "undo")
        rack.looperCommand (LooperProcessor::Command::undo);
}

void PlectrifyEngine::handleMetronomeCommand (const juce::var& payload)
{
    const auto action = payload["action"].toString();
    if (action == "toggle")
        rack.setMetronomeEnabled (! rack.isMetronomeEnabled());
    else if (action == "sync")
        rack.metronomeCommand (MetronomeProcessor::Command::sync);
}

void PlectrifyEngine::saveLooperSessionBeforeClear()
{
    // A loaded session nobody has played over is still on disk as the very
    // file it came from — re-archiving it would grow the list with duplicates
    // every time a session row is clicked (loading clears, and clear archives).
    if (rack.isLooperLoopUnchangedSinceLoad())
        return;

    juce::AudioBuffer<float> audio;
    const int length = rack.snapshotLooperLoop (audio);
    const double rate = rack.getLooperSampleRate();
    if (length <= 0 || rate <= 0.0 || looperSessions == nullptr)
        return;

    juce::WeakReference<PlectrifyEngine> safe (this);
    looperSessions->saveAsync (std::move (audio), length, rate,
        [safe] (LooperSessionStore::SaveResult result)
        {
            if (safe == nullptr || ! result.ok)
                return;
            auto* r = new juce::DynamicObject();
            r->setProperty ("file", result.fileName);
            r->setProperty ("durationSeconds", result.durationSeconds);
            r->setProperty ("sampleRate", result.sampleRate);
            r->setProperty ("timestamp", result.timestampMs);
            safe->emit ("looperSessionSaved", juce::var (r));
        });
}

void PlectrifyEngine::handleLooperLoadSession (const juce::var& payload)
{
    const auto requestId = payload["requestId"];

    juce::File file;
    const double rate = rack.getLooperSampleRate();
    if (looperLoadInFlight || looperSessions == nullptr || rate <= 0.0
        || ! resolveAppFile ("looper-sessions/" + payload["file"].toString(), file)
        || ! file.existsAsFile())
    {
        emitLooperSessionLoaded (requestId, false);
        return;
    }

    looperLoadInFlight = true;
    looperLoadStaged = false;
    pendingLooperLoadRequestId = requestId;
    looperLoadStartMs = juce::Time::getMillisecondCounter();

    const int maxSamples = (int) std::ceil (rate * LooperProcessor::maxLoopSeconds);
    juce::WeakReference<PlectrifyEngine> safe (this);
    looperSessions->loadAsync (file, rate, maxSamples,
        [safe, rate] (LooperSessionStore::LoadResult result)
        {
            if (safe == nullptr)
                return;
            // The device rate changing mid-read would leave the buffer sized
            // for the wrong rate — a fresh click can retry instantly.
            if (! result.ok || safe->rack.getLooperSampleRate() != rate)
            {
                safe->looperLoadInFlight = false;
                safe->emitLooperSessionLoaded (safe->pendingLooperLoadRequestId, false);
                return;
            }
            safe->rack.stageLooperLoad (std::move (result.buffer), result.lengthSamples);
            safe->looperLoadStaged = true;
            // The 15 Hz timer replies once the audio thread has adopted it.
        });
}

void PlectrifyEngine::emitLooperSessionLoaded (const juce::var& requestId, bool ok)
{
    auto* r = new juce::DynamicObject();
    r->setProperty ("requestId", requestId);
    r->setProperty ("ok", ok);
    emit ("looperSessionLoaded", juce::var (r));
}

void PlectrifyEngine::handleRevealAppFolder (const juce::var& payload)
{
    juce::File dir;
    if (! resolveAppFile (payload["dir"].toString(), dir))
        return;

    dir.createDirectory();
    // Directory check after creation: startAsProcess on anything else would
    // hand the path to ShellExecute as an executable.
    if (dir.isDirectory())
        dir.startAsProcess();
}

void PlectrifyEngine::handleOpenExternalUrl (const juce::var& payload)
{
    // Only plain https gets through. launchInDefaultBrowser() ends up in
    // ShellExecute, so an unchecked URL from the page would be a way to open
    // local files or hand arguments to any registered protocol handler.
    const auto url = payload["url"].toString();
    if (! url.startsWithIgnoreCase ("https://"))
        return;

    juce::URL (url).launchInDefaultBrowser();
}

// ---------------------------------------------------------------------------
// Rig capture/apply. The UI owns rig naming/storage; here we only serialize the
// live chain (plugin identity + full tone + mappings) and rebuild it. This is
// the one thing only C++ can do — the webview can't reach the plugin instances.
//
// The same section holds the per-module pair a patch uses
// (captureModuleState/applyModuleState): one plugin's tone rather than the
// whole rack, and applied onto a live instance rather than to a rebuild.
// ---------------------------------------------------------------------------
juce::Array<juce::var> PlectrifyEngine::captureRackEntries() const
{
    // Everything needed to re-create the live rack, in the shape
    // applyRigEntries consumes. Note both "id" and "clientId" carry the same
    // key: the UI has always read "id" and joins its metadata on it, while
    // applyRigEntries reads "clientId" (TypeScript renames the field in
    // captureModules()). Emitting both lets a deep standby park feed its own
    // snapshot straight back through the apply path without going near the UI —
    // reading only "id" there would blank every clientId and, with it, every
    // knob mapping, scene and display name.
    juce::Array<juce::var> entries;
    for (const auto& slot : rack.getSlots())
    {
        auto* inst = rack.getPluginInstance (slot.nodeID);
        if (inst == nullptr && ! slot.missing)
            continue;

        auto* e = new juce::DynamicObject();

        // The shared key, so TS can rejoin its metadata after re-creation.
        e->setProperty ("id", slot.clientId);
        e->setProperty ("clientId", slot.clientId);

        // Lane membership, so a park restores the split topology rather than
        // flattening the rack into one serial chain.
        if (slot.laneId.isNotEmpty())
            e->setProperty ("laneId", slot.laneId);

        if (inst != nullptr)
        {
            // How to re-create the plugin later.
            if (auto xml = inst->getPluginDescription().createXml())
                e->setProperty ("description", xml->toString());

            // The plugin's full internal tone, base64'd for JSON transport.
            juce::MemoryBlock mb;
            inst->getStateInformation (mb);
            e->setProperty ("state", juce::Base64::toBase64 (mb.getData(), mb.getSize()));
        }
        else
        {
            // A missing slot echoes the description/state it was created from,
            // untouched — so saving a rig with a missing plugin keeps the
            // plugin's identity and tone for the day it is reinstalled.
            e->setProperty ("description", slot.missingDescription);
            e->setProperty ("state", slot.missingState);
        }

        e->setProperty ("bypassed", slot.bypassed);

        entries.add (juce::var (e));
    }
    return entries;
}

void PlectrifyEngine::handleCaptureRig (const juce::var& payload)
{
    // While deep standby holds the rig parked there are no live instances to
    // read. Answer from the parked snapshot instead: TS's session autosave calls
    // this, and an empty answer would persist an empty working-rack.json over
    // the user's work.
    const auto entries = isParked() ? *parkedRack.getArray() : captureRackEntries();

    auto* result = new juce::DynamicObject();
    result->setProperty ("requestId", payload["requestId"]);
    result->setProperty ("rack", entries);
    emit ("rigCaptured", juce::var (result));
}

juce::String PlectrifyEngine::captureStateOf (const juce::String& moduleId,
                                              juce::String* pluginNameOut,
                                              juce::String* pluginVersionOut) const
{
    juce::String state, pluginName, pluginVersion;

    if (isParked())
    {
        // Same reasoning as handleCaptureRig: parked means no live instances,
        // and the park snapshot carries exactly what a capture would produce.
        // Answering empty would save a patch with no tone in it.
        for (const auto& entry : *parkedRack.getArray())
            if (entry["id"].toString() == moduleId)
            {
                state = entry["state"].toString();
                break;
            }
    }
    else
    {
        for (const auto& slot : rack.getSlots())
        {
            if (slot.clientId != moduleId)
                continue;

            if (auto* inst = rack.getPluginInstance (slot.nodeID))
            {
                juce::MemoryBlock mb;
                inst->getStateInformation (mb);
                state = juce::Base64::toBase64 (mb.getData(), mb.getSize());
                pluginName = inst->getPluginDescription().name;
                pluginVersion = inst->getPluginDescription().version;
            }
            else if (slot.missing)
            {
                // A placeholder's preserved blob, verbatim — the same courtesy
                // captureRackEntries extends, so saving a patch off a module
                // whose plugin is uninstalled keeps its tone.
                state = slot.missingState;
                pluginName = slot.name;
            }
            break;
        }
    }

    if (pluginNameOut != nullptr)
        *pluginNameOut = pluginName;

    if (pluginVersionOut != nullptr)
        *pluginVersionOut = pluginVersion;

    return state;
}

void PlectrifyEngine::handleCaptureModuleState (const juce::var& payload)
{
    const auto moduleId = payload["moduleId"].toString();
    juce::String pluginName, pluginVersion;
    const auto state = captureStateOf (moduleId, &pluginName, &pluginVersion);

    auto* result = new juce::DynamicObject();
    result->setProperty ("requestId", payload["requestId"]);
    result->setProperty ("ok", state.isNotEmpty());
    result->setProperty ("moduleId", moduleId);
    result->setProperty ("state", state);
    result->setProperty ("pluginName", pluginName);
    result->setProperty ("pluginVersion", pluginVersion);
    emit ("moduleStateCaptured", juce::var (result));
}

juce::String PlectrifyEngine::findNamPluginId()
{
    const auto squashed = [] (juce::String name)
    { return name.removeCharacters (" \t-_").toLowerCase(); };

    for (const auto& type : pluginManager.getKnownPluginList().getTypes())
        if (squashed (type.name) == "neuralampmodeler")
            return type.createIdentifierString();

    return {};
}

void PlectrifyEngine::captureFactoryState (const juce::String& pluginId,
                                           std::function<void (juce::String, juce::var)> onDone)
{
    const auto description = findKnownPlugin (pluginId);

    if (! description.has_value())
    {
        onDone ({}, {});
        return;
    }

    const auto [sampleRate, blockSize] = host.currentRateAndBlock();

    pluginManager.createInstanceAsync (
        *description, sampleRate, blockSize,
        [onDone] (std::unique_ptr<juce::AudioPluginInstance> instance, const juce::String&)
        {
            if (instance == nullptr)
            {
                onDone ({}, {});
                return;
            }

            juce::MemoryBlock block;
            instance->getStateInformation (block);

            // The parameter list travels with the state so the page can build a
            // sensible default knob mapping for a patch created with no module
            // on screen — the same information a live module would have given it.
            juce::Array<juce::var> parameters;
            const auto& params = instance->getParameters();

            for (int i = 0; i < params.size(); ++i)
            {
                auto* entry = new juce::DynamicObject();
                entry->setProperty ("index", i);
                entry->setProperty ("name", params[i]->getName (64));
                parameters.add (juce::var { entry });
            }

            onDone (juce::Base64::toBase64 (block.getData(), block.getSize()), parameters);
            // The instance is dropped here: it was never in the graph, never
            // prepared, and existed only to be asked what its factory state is.
        });
}

void PlectrifyEngine::handleApplyModuleState (const juce::var& payload)
{
    // Fire-and-forget, like setParam: the truth comes back on the next
    // paramValues poll, so there is nothing for the UI to await.
    juce::MemoryOutputStream decoded;
    if (! juce::Base64::convertFromBase64 (decoded, payload["state"].toString()))
        return; // corrupt blob: leave the plugin exactly as it is

    const juce::MemoryBlock block (decoded.getData(), decoded.getDataSize());
    rack.applyPluginState (payload["moduleId"].toString(), block);
}

void PlectrifyEngine::tearDownRack()
{
    editorWindows.clear();
    rack.dissolveAllSplits();

    std::vector<juce::AudioProcessorGraph::NodeID> ids;
    for (const auto& slot : rack.getSlots())
    {
        // Not optional: deep standby runs this destroy/recreate cycle
        // unattended for the app's lifetime, so a leaked listener registration
        // is a dangling pointer waiting for the first plugin that notifies from
        // its own thread.
        if (auto* instance = rack.getPluginInstance (slot.nodeID))
            instance->removeListener (this);
        ids.push_back (slot.nodeID);
    }
    for (auto id : ids)
        rack.removePlugin (id);
}

void PlectrifyEngine::handleApplyRig (const juce::var& payload)
{
    auto entries = std::make_shared<juce::Array<juce::var>> (
        payload["rack"].getArray() != nullptr ? *payload["rack"].getArray()
                                               : juce::Array<juce::var>{});
    const auto routing = payload["routing"];
    const auto requestId = payload["requestId"];
    auto failures = std::make_shared<juce::Array<juce::var>>();

    // This apply owns the rack from here, so drop any standby park rather than
    // waking it first. Clearing standbySuspended is not optional: it is a term
    // inside updateSuspendedStates(), so leaving it set would faithfully
    // re-suspend every plugin as the new rig is added and bring it up silent.
    abandonStandby();

    // Silence the output before anything is announced or torn down; the delay
    // below doubles as the fade-out window.
    const int loadGeneration = beginRigLoadMute();

    // Publish the loading state before teardown. The short delay lets WebView2
    // paint the indicator before plugin destruction/creation begins.
    emitRigApplyProgress (requestId, 0, entries->size());
    juce::WeakReference<PlectrifyEngine> safe (this);
    juce::Timer::callAfterDelay (50, [safe, entries, routing, requestId, failures, loadGeneration]
    {
        if (safe == nullptr)
            return;

        safe->tearDownRack();
        safe->applyRigEntries (entries, routing, 0, requestId, failures, loadGeneration);
    });
}

int PlectrifyEngine::beginRigLoadMute()
{
    const int generation = ++rigLoadGeneration;
    rack.setLoadMuted (true);
    rigLoadInFlight = true;

    // Safety net: if a plugin's async creation callback never arrives the apply
    // chain stalls, which would leave the rig permanently silent. Hand the audio
    // back exactly when the UI gives up on the apply (APPLY_RIG_TIMEOUT_MS).
    juce::WeakReference<PlectrifyEngine> safe (this);
    juce::Timer::callAfterDelay (120000, [safe, generation]
    {
        if (safe != nullptr)
            safe->endRigLoadMute (generation);
    });
    return generation;
}

void PlectrifyEngine::endRigLoadMute (int generation)
{
    if (! ownsRack (generation))
        return; // a newer apply owns the mute now

    // The render sequence for the rebuilt graph is picked up by the audio thread
    // asynchronously, and a just-instantiated plugin can spit out its first
    // blocks while it settles. Hold the mute a beat past "done".
    juce::WeakReference<PlectrifyEngine> safe (this);
    juce::Timer::callAfterDelay (150, [safe, generation]
    {
        if (safe != nullptr && safe->ownsRack (generation))
        {
            safe->rack.setLoadMuted (false);
            safe->rigLoadInFlight = false;
        }
    });
}

// --- Auto Standby ----------------------------------------------------------
bool PlectrifyEngine::standbyIsBlocked() const
{
    // The host's own reasons first: no open device means no peaks arrive at
    // all (the detector would read permanent silence and park a rig the user
    // can't even hear yet), and the setup wizard's armed input meters mean
    // silence is the question being answered, not an idle rig.
    if (host.blocksAutoStandby())
        return true;

    // Never tear down a rack that is already being built.
    if (rigLoadInFlight)
        return true;

    // A scan instantiates plugins in-process — and is the user doing something.
    if (pluginManager.isScanning())
        return true;

    // A catalogue install runs for minutes with no UI interaction, so the
    // idle clock would otherwise expire mid-download and park the rig while
    // the user is watching a progress bar.
    if (catalogue.isRunning())
        return true;

    // A deep park would destroy the instance under an open editor, and even a
    // light suspend leaves its meters frozen, which reads as a hang.
    if (! editorWindows.empty())
        return true;

    // Covers the audio settings window and every async alert.
    if (auto* modals = juce::ModalComponentManager::getInstance())
        if (modals->getNumModalComponents() > 0)
            return true;

    // A playing loop is audible output with a silent guitar: the idle detector
    // watches the input, so without this it would park mid-performance.
    if (rack.isLooperActive())
        return true;

    // The fixed click node is not one of the hosted slots and therefore is not
    // suspended by light standby. Treat audible clicks as live performance.
    if (rack.isMetronomeRunning())
        return true;

    return false;
}

void PlectrifyEngine::noteStandbyActivity()
{
    standby.noteActivity (juce::Time::getMillisecondCounter());
}

bool PlectrifyEngine::wakeForRackEdit()
{
    noteStandbyActivity();
    // Still parked means the wake is an async rebuild that has only just
    // started; there are no instances for the caller to mutate yet.
    return ! isParked();
}

void PlectrifyEngine::abandonStandby()
{
    parkedRack = juce::var();
    parkedRouting = juce::var();
    standbyWakeFailures.clear();
    rack.setStandbySuspended (false);
    rack.setStandbyMuted (false);
    standby.abandon (juce::Time::getMillisecondCounter());
}

void PlectrifyEngine::enterLightStandby()
{
    // Mute first, suspend after the fade. Suspension makes the graph clear each
    // node's buffer, so doing it while the chain is still audible truncates a
    // plugin's tail mid-decay — a click, which is exactly what the output's
    // ramp exists to avoid. 50 ms comfortably clears that 15 ms ramp, and is
    // the same beat handleApplyRig waits before tearing the chain down.
    rack.setStandbyMuted (true);

    juce::WeakReference<PlectrifyEngine> safe (this);
    juce::Timer::callAfterDelay (50, [safe]
    {
        // Re-check the stage: a strum during the fade wakes us, and suspending
        // then would silence a rig the user is already playing.
        if (safe != nullptr && safe->standby.getStage() == StandbyController::Stage::light)
            safe->rack.setStandbySuspended (true);
    });
}

void PlectrifyEngine::exitLightStandby()
{
    // Resume, then un-mute, both in this message-loop turn. The un-mute ramps
    // over 15 ms, which is more than enough for the resumed nodes to start
    // producing; delaying it would land directly on wake latency.
    rack.setStandbySuspended (false);
    rack.setStandbyMuted (false);
}

void PlectrifyEngine::enterDeepStandby()
{
    // Capture before anything is destroyed: this snapshot becomes the only copy
    // of the user's live tone until the wake completes.
    parkedRack = captureRackEntries();
    parkedRouting = buildRoutingState();
    standbyWakeFailures.clear();

    // No beginRigLoadMute() here: the standby mute is already engaged from the
    // light stage and, unlike the load mute, has no 120 s watchdog to release it
    // partway through a park meant to last hours. The generation still has to
    // move: a park replaces the rack, so any deferred work that resolved an
    // index against the rig being torn down must not land in the parked one.
    // Nothing live is stranded — standbyIsBlocked() holds a park off entirely
    // while rigLoadInFlight.
    ++rigLoadGeneration;
    tearDownRack();

    // Deliberately no emitRackChanged(): telling the UI the rack is empty would
    // blank the workspace, prune every knob mapping, and let the session
    // autosave persist an empty rack over the user's work.
    emitStatusChanged();
}

void PlectrifyEngine::beginWakeFromDeepStandby()
{
    if (! isParked())
    {
        // Nothing parked (an empty rack, or a rig apply took over): just come
        // back up rather than stranding the controller in `waking`.
        rack.setStandbySuspended (false);
        rack.setStandbyMuted (false);
        standby.deepWakeFinished (juce::Time::getMillisecondCounter(), true);
        return;
    }

    auto entries = std::make_shared<juce::Array<juce::var>> (*parkedRack.getArray());
    auto failures = std::make_shared<juce::Array<juce::var>>();
    const auto routing = parkedRouting;
    const int loadGeneration = beginRigLoadMute();

    // A void requestId still drives the UI's progress dialog and workspace lock:
    // its handler keys off the payload, not the id. The wake gets both for free.
    emitRigApplyProgress ({}, 0, entries->size());

    juce::WeakReference<PlectrifyEngine> safe (this);
    auto onFinished = std::make_shared<std::function<void()>> ([safe, failures]
    {
        if (safe == nullptr)
            return;

        // Unconditional, not generation-guarded. A rig apply landing mid-wake
        // stops the chain before it reaches here (applyRigEntries bails on the
        // stale generation), so this runs for a wake that completed as its own
        // owner — where endRigLoadMute() no-opping must not leave the standby
        // suspension up, or the rig comes back silent.
        safe->rack.setStandbySuspended (false);
        safe->rack.setStandbyMuted (false);

        // Drop the park unconditionally, even when plugins failed to come back.
        // The snapshot is what isParked() answers with, and while it is held
        // every rack edit is refused, requestRack stays silent and captureRig
        // reports pre-park state — with the controller already back in `active`
        // nothing can start a second wake, so keeping it would leave a rig that
        // looks awake but can never be touched again. What failed is named in
        // the status payload instead.
        safe->parkedRack = juce::var();
        safe->parkedRouting = juce::var();
        safe->standbyWakeFailures = *failures;

        safe->emitParamTexts();
        safe->standby.deepWakeFinished (juce::Time::getMillisecondCounter(), failures->isEmpty());
        safe->emitStatusChanged();
    });

    // Let WebView2 paint the progress dialog before plugin creation starts
    // blocking the message thread, exactly as a rig apply does.
    juce::Timer::callAfterDelay (50, [safe, entries, routing, failures, loadGeneration, onFinished]
    {
        if (safe != nullptr)
            safe->applyRigEntries (entries, routing, 0, {}, failures, loadGeneration, onFinished);
    });
}

void PlectrifyEngine::handleSetStandby (const juce::var& payload)
{
    auto* object = payload.getDynamicObject();
    if (object == nullptr)
        return;

    // Absent fields mean "leave unchanged", matching handleSetStatus.
    auto config = standby.getConfig();
    if (object->hasProperty ("enabled"))           config.enabled = (bool) payload["enabled"];
    if (object->hasProperty ("lightAfterMinutes")) config.lightAfterMinutes = (double) payload["lightAfterMinutes"];
    if (object->hasProperty ("deepAfterMinutes"))  config.deepAfterMinutes = (double) payload["deepAfterMinutes"];
    if (object->hasProperty ("wakeThresholdDb"))   config.wakeThresholdDb = (float) (double) payload["wakeThresholdDb"];

    standby.setConfig (config, juce::Time::getMillisecondCounter());
    emitStatusChanged();
}

void PlectrifyEngine::handleStandbyCommand (const juce::var& payload)
{
    const auto action = payload["action"].toString();
    const auto now = juce::Time::getMillisecondCounter();

    if (action == "sleep")
    {
        // Forced standby, so the feature is testable without waiting out the
        // timeout. Honours the same guards as the automatic path.
        if (! standbyIsBlocked() && ! rack.getSlots().empty())
            standby.forceLightStandby();
        return;
    }

    // "wake" and "activity" are the same transition; the overlay's Wake button
    // exists because during a deep park it is the only thing left to click, and
    // clicking it fires no other bridge event.
    standby.noteActivity (now);
}

void PlectrifyEngine::emitRigApplyProgress (const juce::var& requestId, int current, int total,
                                            const juce::String& pluginName, bool done)
{
    auto* progress = new juce::DynamicObject();
    progress->setProperty ("requestId", requestId);
    progress->setProperty ("current", current);
    progress->setProperty ("total", total);
    progress->setProperty ("pluginName", pluginName);
    progress->setProperty ("done", done);
    emit ("rigApplyProgress", juce::var (progress));
}

void PlectrifyEngine::applyRigEntries (std::shared_ptr<juce::Array<juce::var>> entries,
                                       juce::var routing, int index, juce::var requestId,
                                       std::shared_ptr<juce::Array<juce::var>> failures,
                                       int loadGeneration,
                                       std::shared_ptr<std::function<void()>> onFinished)
{
    // Every step of this chain is deferred (plugin creation is async, and each
    // slot yields a message-loop turn), so a newer apply, wake or park can take
    // the rack in between. Stop rather than append this chain's plugins to the
    // rack that replaced its own. One check covers all four re-entry points.
    //
    // Dropping `onFinished` with it is safe: only handleApplyRig supersedes a
    // wake, and its abandonStandby() already clears the standby flags, drops
    // the park and returns the controller to active — everything onFinished
    // exists to do.
    if (! ownsRack (loadGeneration))
        return;

    const auto recordFailure = [&failures] (const juce::String& name, const juce::String& why)
    {
        auto* failure = new juce::DynamicObject();
        failure->setProperty ("name", name);
        failure->setProperty ("error", why);
        failures->add (juce::var (failure));
    };

    if (index >= entries->size())
    {
        auto applyGroup = [this, entries] (const juce::var& group)
        {
            juce::StringArray laneIds;
            if (auto* lanes = group["lanes"].getArray())
                for (const auto& lane : *lanes)
                    laneIds.add (lane["id"].toString());

            if (laneIds.size() < 2)
                return;

            auto groupId = group["id"].toString();
            if (groupId.isEmpty())
                groupId = "legacy-group";

            rack.createSplit (groupId, {}, (int) group["position"], laneIds);
            for (const auto& entry : *entries)
                if (entry["laneId"].toString().isNotEmpty())
                    rack.movePluginToLane (entry["clientId"].toString(), entry["laneId"].toString());

            if (auto* lanes = group["lanes"].getArray())
                for (const auto& lane : *lanes)
                    rack.setLaneMix (lane["id"].toString(), (float) (double) lane["gain"],
                                     (float) (double) lane["pan"], (bool) lane["muted"],
                                     (bool) lane["soloed"]);
            rack.setLaneSwitch (groupId, group["activeLaneId"].toString());
        };

        if (auto* groups = routing["groups"].getArray())
        {
            for (const auto& group : *groups)
                applyGroup (group);
        }
        else if (routing["lanes"].getArray() != nullptr)
        {
            auto* legacy = new juce::DynamicObject();
            legacy->setProperty ("id", "legacy-group");
            legacy->setProperty ("position", routing["groupPosition"]);
            legacy->setProperty ("lanes", routing["lanes"]);
            applyGroup (juce::var (legacy));
        }
        emitRackChanged();
        emitRigApplyProgress (requestId, entries->size(), entries->size(), {}, true);

        // Single exit funnel for every outcome — success, skipped plugins, an
        // empty rack (new rig) — so the load mute can never stick.
        endRigLoadMute (loadGeneration);

        // A module the user saved must never vanish silently: name each one
        // that could not come back, and why. A standby wake reports through the
        // status payload instead — the user did not ask for anything, so a modal
        // must not appear over whatever they are doing.
        if (! failures->isEmpty() && ! requestId.isVoid())
        {
            juce::StringArray lines;
            for (const auto& failure : *failures)
                lines.add (failure["name"].toString() + ": " + failure["error"].toString());
            juce::AlertWindow::showMessageBoxAsync (
                juce::AlertWindow::WarningIcon, "Some plugins could not be restored",
                lines.joinIntoString ("\n")
                    + "\n\nTheir modules stay in the rack marked as missing and pass audio "
                      "through. Reinstall the plugins and load the rig again to bring them back.");
        }

        // No requestId means nobody in the UI is awaiting a reply (a standby
        // wake drives this path itself); an unmatched one would just sit in the
        // bridge's pending map until it times out.
        if (! requestId.isVoid())
        {
            auto* result = new juce::DynamicObject();
            result->setProperty ("requestId", requestId);
            result->setProperty ("failures", *failures);
            emit ("rigApplied", juce::var (result));
        }

        if (onFinished != nullptr && *onFinished)
            (*onFinished)();
        return;
    }

    const auto entry = (*entries)[index];

    juce::PluginDescription desc;
    auto descXml = juce::XmlDocument::parse (entry["description"].toString());
    if (descXml == nullptr || ! desc.loadFromXml (*descXml))
    {
        // Can't identify this plugin — keep its slot as a visible "missing"
        // placeholder (audibly inert, like a bypassed slot) and keep the rest
        // of the chain. Preserving the stored description/state means a later
        // save cannot lose the plugin for good.
        recordFailure ("Unknown plugin", "The stored plugin description is unreadable.");
        const auto nodeID = rack.addMissingPlugin (entry["clientId"].toString(), "Unknown plugin",
                                                   entry["description"].toString(),
                                                   entry["state"].toString(),
                                                   (int) rack.getSlots().size());
        rack.setBypassed (nodeID, (bool) entry["bypassed"]);
        juce::WeakReference<PlectrifyEngine> safe (this);
        juce::Timer::callAfterDelay (25, [safe, entries, routing, index, requestId, failures, loadGeneration, onFinished]
        {
            if (safe != nullptr)
                safe->applyRigEntries (entries, routing, index + 1, requestId, failures, loadGeneration, onFinished);
        });
        return;
    }

    // The log's last line names the plugin being restored if this launch never
    // finishes — a crash inside a plugin's instantiation or setState is
    // otherwise indistinguishable from one in the host.
    juce::Logger::writeToLog ("Restoring slot " + juce::String (index + 1) + "/"
                              + juce::String (entries->size()) + ": " + desc.name);
    emitRigApplyProgress (requestId, index + 1, entries->size(), desc.name);

    const auto [sampleRate, blockSize] = host.currentRateAndBlock();

    // The callback is always delivered through the message queue, so it can
    // arrive after the engine (and the rack) have been destroyed.
    juce::WeakReference<PlectrifyEngine> safe (this);
    pluginManager.createInstanceAsync (desc, sampleRate, blockSize,
        [safe, entries, routing, index, entry, requestId, failures, loadGeneration, onFinished, pluginName = desc.name]
        (std::unique_ptr<juce::AudioPluginInstance> instance, const juce::String& error)
        {
            // This one mutates the rack before it recurses, so it needs the
            // generation check of its own that the recursion would apply too.
            if (safe == nullptr || ! safe->ownsRack (loadGeneration))
                return; // shutting down, or superseded mid-apply; drop the instance

            if (instance == nullptr)
            {
                auto* failure = new juce::DynamicObject();
                failure->setProperty ("name", pluginName);
                failure->setProperty ("error", error.isNotEmpty() ? error : "Unknown error");
                failures->add (juce::var (failure));

                // The module stays in the rack as a visible "missing"
                // placeholder — audibly inert, like a bypassed slot — with the
                // stored description/state preserved, so the user sees what is
                // gone and reinstalling the plugin brings it back intact.
                const auto nodeID = safe->rack.addMissingPlugin (entry["clientId"].toString(), pluginName,
                                                                 entry["description"].toString(),
                                                                 entry["state"].toString(),
                                                                 (int) safe->rack.getSlots().size());
                safe->rack.setBypassed (nodeID, (bool) entry["bypassed"]);
            }
            else
            {
                // Restore the plugin's tone (best-effort — a rejecting plugin
                // must not abort the whole rig).
                juce::MemoryOutputStream decoded;
                if (juce::Base64::convertFromBase64 (decoded, entry["state"].toString()))
                    instance->setStateInformation (decoded.getData(), (int) decoded.getDataSize());

                // Re-create with the same clientId TS holds metadata under, so
                // the echoed node list rejoins its knobs/display name exactly.
                const auto nodeID = safe->rack.addPlugin (std::move (instance),
                                                          (int) safe->rack.getSlots().size(),
                                                          entry["clientId"].toString());
                if (auto* added = safe->rack.getPluginInstance (nodeID))
                    added->addListener (safe.get());
                safe->rack.setBypassed (nodeID, (bool) entry["bypassed"]);
            }

            // Continue in order regardless of this slot's success. Yield a
            // message-loop turn so WebView2 can paint and handle queued input.
            juce::Timer::callAfterDelay (25, [safe, entries, routing, index, requestId, failures, loadGeneration, onFinished]
            {
                if (safe != nullptr)
                    safe->applyRigEntries (entries, routing, index + 1, requestId, failures, loadGeneration, onFinished);
            });
        });
}

// ---------------------------------------------------------------------------
// Generic, sandboxed file I/O under the app-data dir. The UI drives rig and
// session persistence with these; every path is confined to Plectrify/.
// ---------------------------------------------------------------------------
juce::File PlectrifyEngine::appDataDir() const
{
    return plectrify::appDataDir();
}

bool PlectrifyEngine::resolveAppFile (const juce::String& rel, juce::File& out) const
{
    const auto base = appDataDir();
    const auto f = base.getChildFile (rel);
    if (f != base && ! f.isAChildOf (base))
        return false; // path escaped the sandbox (e.g. "../something")

    // The one carve-out in this sandbox, and the reason it exists is worth
    // stating: tone3000/credentials.json holds a TONE3000 access and refresh
    // token. Everything else under appDataDir() is the page's own data — rigs,
    // patches, settings — and it may read, write and delete all of it. A bearer
    // credential is not the page's, and this directory also hosts third-party
    // plugin editors, so the segment is reserved for the native slice and
    // refused here for reads, writes, listings and deletes alike.
    if (f.isAChildOf (base.getChildFile ("tone3000")) || f == base.getChildFile ("tone3000"))
        return false;

    out = f;
    return true;
}

juce::File PlectrifyEngine::sharedPatchesDir()
{
    return CatalogueInstaller::contentDirectory ("patches");
}

#if defined(PLECTRIFY_CONTENT_SOURCE_DIR)
std::map<juce::String, juce::File> PlectrifyEngine::sharedPatchSources()
{
    std::map<juce::String, juce::File> sources;
    const juce::File root { PLECTRIFY_CONTENT_SOURCE_DIR };
    const juce::String suffix = juce::String (".") + catalogueRuntimePlatform;

    for (const auto& dir : root.findChildFiles (juce::File::findDirectories, false, "*"))
    {
        const auto name = dir.getFileName();
        // A pack is authored per platform, because the saved tone bakes that
        // platform's install path into the plugin state — so a folder built
        // for the other OS is not this build's to read. A folder with no
        // suffix at all is the OS-neutral shape, which path-free content ships
        // as and a patch never can; it is taken only if it holds one anyway.
        const auto packageId = name.endsWith (suffix) ? name.dropLastCharacters (suffix.length())
                                                      : name;
        if (packageId == name && name.containsChar ('.'))
            continue;

        // The two shapes `host` ships, and the same test it applies: a folder
        // holding a patch.json IS one patch, and installs wrapped in a folder
        // named for the package; anything else ships flat, so each of its
        // subfolders installs under its own name. Either way the key here is
        // the folder the pack occupies in patches/, which is what the page
        // asks for.
        if (dir.getChildFile ("patch.json").existsAsFile())
            sources.emplace (packageId, dir);
        else
            for (const auto& sub : dir.findChildFiles (juce::File::findDirectories, false, "*"))
                if (sub.getChildFile ("patch.json").existsAsFile())
                    sources.emplace (sub.getFileName(), sub);
    }

    return sources;
}

juce::File PlectrifyEngine::sharedPatchSourceDir (const juce::String& patchId)
{
    if (patchId.isEmpty() || patchId.containsChar ('.'))
        return {};

    const auto sources = sharedPatchSources();
    const auto found = sources.find (patchId);
    return found != sources.end() ? found->second : juce::File();
}

juce::StringArray PlectrifyEngine::sharedPatchSourceIds()
{
    juce::StringArray ids;
    for (const auto& [id, dir] : sharedPatchSources())
        ids.add (id);

    return ids;
}

bool PlectrifyEngine::resolveSharedSourceFile (const juce::String& rel, juce::File& out)
{
    const auto relative = rel.replaceCharacter ('\\', '/');
    const auto source = sharedPatchSourceDir (relative.upToFirstOccurrenceOf ("/", false, false));
    const auto rest = relative.fromFirstOccurrenceOf ("/", false, false);
    if (source == juce::File() || rest.isEmpty())
        return false;

    // The repo folder is the only writable thing here, and only within itself.
    const auto f = source.getChildFile (rest);
    if (! f.isAChildOf (source))
        return false;

    out = f;
    return true;
}
#endif

bool PlectrifyEngine::resolveSharedFile (const juce::String& rel, juce::File& out) const
{
    const auto base = sharedPatchesDir();
    const auto f = base.getChildFile (rel);
    if (f != base && ! f.isAChildOf (base))
        return false; // path escaped the shared root

   #if defined(PLECTRIFY_CONTENT_SOURCE_DIR)
    // Debug-only: the repo's own sources for a pack shadow the installed copy,
    // per package id and file by file. Only what the repo actually has is
    // shadowed, so a pack whose assets are installed but whose document is
    // being edited here reads the edited document beside the installed assets
    // — which is the case that matters, since a patch's plugin state names its
    // assets by absolute installed path and no override can rewrite that.
    const auto relative = f.getRelativePathFrom (base).replaceCharacter ('\\', '/');
    if (const auto source = sharedPatchSourceDir (relative.upToFirstOccurrenceOf ("/", false, false));
        source != juce::File())
    {
        const auto rest = relative.fromFirstOccurrenceOf ("/", false, false);
        if (const auto overridden = rest.isEmpty() ? source : source.getChildFile (rest);
            overridden.exists())
        {
            out = overridden;
            return true;
        }
    }
   #endif

    out = f;
    return true;
}

bool PlectrifyEngine::resolveReadableFile (const juce::var& payload, const juce::String& rel,
                                           juce::File& out) const
{
    return payload["root"].toString() == "shared" ? resolveSharedFile (rel, out)
                                                  : resolveAppFile (rel, out);
}

bool PlectrifyEngine::resolveWritableFile (const juce::var& payload, const juce::String& rel,
                                           juce::File& out) const
{
    if (payload["root"].toString() != "shared")
        return resolveAppFile (rel, out);

   #if defined(PLECTRIFY_CONTENT_SOURCE_DIR)
    // Debug-only, and it does not write where the reads come from: the target
    // is the pack's sources in the repo, never the installed copy under the
    // shared content root. Authoring a pack is editing those sources, so the
    // app writing them back is the same act as editing the JSON by hand — a
    // pack that is only installed, with no folder here, has no writable path
    // at all and this refuses it.
    return resolveSharedSourceFile (rel, out);
   #else
    // A release build has no writable shared root of any kind, and must not
    // quietly answer with the app-data one: a page asking for "shared" is
    // asking for something this build does not have, and silently writing a
    // pack's document into %APPDATA% would be a worse answer than none.
    juce::ignoreUnused (rel, out);
    return false;
   #endif
}

void PlectrifyEngine::handleWriteFile (const juce::var& payload)
{
    bool ok = false;
    juce::File f;
    if (resolveWritableFile (payload, payload["path"].toString(), f))
    {
        f.getParentDirectory().createDirectory();

        // Write through a sibling temporary file so a process crash cannot leave
        // the session JSON half-written. replaceFileIn performs the final swap.
        //
        // The name carries this engine's own id because the data root is shared:
        // the standalone and every plugin instance write these same paths, and a
        // fixed ".tmp" would have one writer delete another's half-written file
        // and swap the remains into place.
        const auto temporary = f.getSiblingFile (f.getFileName() + "." + writerId + ".tmp");
        temporary.deleteFile();
        if (temporary.replaceWithText (payload["text"].toString()))
            ok = f.existsAsFile() ? temporary.replaceFileIn (f) : temporary.moveFileTo (f);
    }

    // Persistence failures are silent data loss unless someone says so, and this
    // ack is how: the UI raises its own non-modal notice on every failed write.
    // Nothing is reported from here — a modal would interrupt a live player, and
    // an autosave can fail while nobody is even at the machine.
    auto* r = new juce::DynamicObject();
    r->setProperty ("requestId", payload["requestId"]);
    r->setProperty ("ok", ok);
    emit ("fileWritten", juce::var (r));
}

void PlectrifyEngine::handleReadFile (const juce::var& payload)
{
    juce::File f;
    const bool ok = resolveReadableFile (payload, payload["path"].toString(), f)
                    && f.existsAsFile();

    if (ok)
    {
        auto text = std::make_shared<juce::String> (f.loadFileAsString());
        constexpr int chunkSize = 16 * 1024;
        if (text->length() > chunkSize)
        {
            juce::MemoryOutputStream compressed;
            {
                juce::GZIPCompressorOutputStream gzip (
                    compressed, 6, juce::GZIPCompressorOutputStream::windowBitsGZIP);
                gzip.write (text->toRawUTF8(), (size_t) text->getNumBytesAsUTF8());
            }
            auto encoded = std::make_shared<juce::String> (
                juce::Base64::toBase64 (compressed.getData(), compressed.getDataSize()));

            // Repeated plugin snapshots compress heavily. Fall back to plain
            // UTF-8 for an unusually incompressible file.
            if (encoded->length() < text->length())
                emitFileReadChunk (payload["requestId"], std::move (encoded), "gzip-base64", 0, 0);
            else
                emitFileReadChunk (payload["requestId"], std::move (text), "utf8", 0, 0);
            return;
        }
    }

    auto* r = new juce::DynamicObject();
    r->setProperty ("requestId", payload["requestId"]);
    r->setProperty ("ok", ok);
    r->setProperty ("text", ok ? f.loadFileAsString() : juce::String());
    emit ("fileRead", juce::var (r));
}

void PlectrifyEngine::emitFileReadChunk (juce::var requestId, std::shared_ptr<juce::String> text,
                                         juce::String encoding, int offset, int chunkIndex)
{
    constexpr int chunkSize = 16 * 1024;
    const int totalChunks = (text->length() + chunkSize - 1) / chunkSize;
    const int end = juce::jmin (offset + chunkSize, text->length());

    auto* chunk = new juce::DynamicObject();
    chunk->setProperty ("requestId", requestId);
    chunk->setProperty ("index", chunkIndex);
    chunk->setProperty ("total", totalChunks);
    chunk->setProperty ("text", text->substring (offset, end));
    chunk->setProperty ("done", false);
    emit ("fileReadChunk", juce::var (chunk));

    juce::WeakReference<PlectrifyEngine> safe (this);
    juce::Timer::callAfterDelay (1, [safe, requestId, text = std::move (text),
                                     encoding = std::move (encoding), end, chunkIndex]
    {
        if (safe == nullptr)
            return;

        if (end < text->length())
        {
            safe->emitFileReadChunk (requestId, text, encoding, end, chunkIndex + 1);
            return;
        }

        auto* done = new juce::DynamicObject();
        done->setProperty ("requestId", requestId);
        done->setProperty ("total", chunkIndex + 1);
        done->setProperty ("done", true);
        done->setProperty ("ok", true);
        done->setProperty ("encoding", encoding);
        safe->emit ("fileReadChunk", juce::var (done));
    });
}

void PlectrifyEngine::handleListFiles (const juce::var& payload)
{
    juce::File dir;
    juce::Array<juce::var> names, dirs;
    if (resolveReadableFile (payload, payload["dir"].toString(), dir) && dir.isDirectory())
    {
        for (const auto& f : dir.findChildFiles (juce::File::findFiles, false, "*"))
            names.add (f.getFileName());

        // Reported apart rather than mixed in: every existing caller lists a
        // flat directory and would otherwise have to tell a file from a folder
        // by its name, which is a guess. An installed patch that carries its
        // own assets is a folder, so the shared root needs both answers.
        for (const auto& f : dir.findChildFiles (juce::File::findDirectories, false, "*"))
            dirs.add (f.getFileName());
    }

   #if defined(PLECTRIFY_CONTENT_SOURCE_DIR)
    // Debug-only: a pack the repo carries is listed whether it is installed or
    // not, so a new one shows up in the drawer without a publish. Outside that
    // block (the installed root may not exist at all on a dev machine) and
    // deduplicated against it, since an installed pack is already named.
    juce::Array<juce::var> writable;
    if (payload["root"].toString() == "shared" && payload["dir"].toString().isEmpty())
        for (const auto& id : sharedPatchSourceIds())
        {
            if (! dirs.contains (juce::var (id)))
                dirs.add (id);

            // Reported so the page can offer to write one back. Named rather
            // than implied by a build flag: a pack the repo does not carry is
            // read-only even here, so "which are editable" is a fact about
            // this machine's source tree and only this side knows it.
            writable.add (id);
        }
   #endif

    auto* r = new juce::DynamicObject();
    r->setProperty ("requestId", payload["requestId"]);
    r->setProperty ("names", names);
    r->setProperty ("dirs", dirs);
   #if defined(PLECTRIFY_CONTENT_SOURCE_DIR)
    r->setProperty ("writable", writable);
   #endif
    emit ("filesListed", juce::var (r));
}

void PlectrifyEngine::handleDeleteFile (const juce::var& payload)
{
    juce::File f;
    if (resolveAppFile (payload["path"].toString(), f))
        f.deleteFile();
}

// ---------------------------------------------------------------------------
// Plugin editors + plugin instantiation.
// ---------------------------------------------------------------------------
std::optional<juce::PluginDescription> PlectrifyEngine::findKnownPlugin (const juce::String& pluginId)
{
    for (const auto& desc : pluginManager.getKnownPluginList().getTypes())
        if (desc.createIdentifierString() == pluginId)
            return desc;
    return std::nullopt;
}

void PlectrifyEngine::addPluginFromDescription (const juce::PluginDescription& desc, int index,
                                                const juce::String& clientId, const juce::String& laneId,
                                                std::optional<int> serialPosition,
                                                const juce::String& beforeGroupId,
                                                bool openEditor)
{
    const auto [sampleRate, blockSize] = host.currentRateAndBlock();

    // `index` was resolved against the rack as it stands now, so the callback
    // is only allowed to use it while that rack is still the current one.
    const int generation = rigLoadGeneration;

    // The callback is always delivered through the message queue, so it can
    // arrive after the engine (and the rack) have been destroyed.
    juce::WeakReference<PlectrifyEngine> safe (this);
    pluginManager.createInstanceAsync (desc, sampleRate, blockSize,
        [safe, generation, index, clientId, laneId, serialPosition, beforeGroupId, openEditor]
        (std::unique_ptr<juce::AudioPluginInstance> instance, const juce::String& error)
        {
            if (safe == nullptr || ! safe->ownsRack (generation))
                return; // shutting down, or the rack this targets is gone; discard

            if (instance == nullptr)
            {
                juce::AlertWindow::showMessageBoxAsync (
                    juce::AlertWindow::WarningIcon, "Could not load plugin",
                    error.isNotEmpty() ? error : "Unknown error");
                return;
            }

            const auto nodeID = safe->rack.addPlugin (std::move (instance), index, clientId,
                                                      serialPosition, beforeGroupId);
            if (auto* added = safe->rack.getPluginInstance (nodeID))
                added->addListener (safe.get());
            if (laneId.isNotEmpty())
                safe->rack.movePluginToLane (clientId, laneId);
            safe->emitRackChanged();
            // A module built from scratch almost always gets dialled in right
            // away, so pop its native editor without an extra click. One built
            // from a patch is already dialled in — its tone and knobs arrive
            // with it — so the window would only be in the way.
            if (openEditor)
                safe->openEditorFor (nodeID);
        });
}

void PlectrifyEngine::scanBundledPluginsIfNeeded()
{
    const auto bundled = PluginManager::getBundledPluginDirectory();

    if (! bundled.isDirectory() || bundled.findChildFiles (juce::File::findFilesAndDirectories, false, "*.vst3").isEmpty())
        return;

    // Already in the cache: nothing to do, which is every launch but the first
    // after an install or an update.
    if (findNamPluginId().isNotEmpty())
        return;

    juce::FileSearchPath path;
    path.add (bundled);

    juce::WeakReference<PlectrifyEngine> safe (this);
    pluginManager.scanAndAddPluginsAsync (
        path,
        [] (bool) {},
        [safe]
        {
            juce::MessageManager::callAsync ([safe]
            {
                if (safe == nullptr)
                    return;

                safe->emitPluginsChanged();
                safe->emitPluginScanChanged ("complete");
                safe->emitAppInfo();
            });
        });
}

void PlectrifyEngine::scanForPlugins()
{
    startScan (pluginManager.getDefaultSearchPaths());
}

void PlectrifyEngine::requestFullRescan()
{
    // Same queueing as scanManagedPlugins, and for the same reason: a scan
    // already running started before the install did, so it cannot report what
    // arrived. The user's own Rescan press stays a plain drop — that scan is
    // already running and already reporting, and queueing a second full walk of
    // every VST3 folder buys nothing.
    if (! startScan (pluginManager.getDefaultSearchPaths()))
        pendingFullRescan = true;
}

void PlectrifyEngine::scanManagedPlugins()
{
    juce::FileSearchPath path;
    path.add (PluginManager::getManagedPluginDirectory());

    // A scan already running is not this scan: it read the directory before the
    // package run changed it, so its result would describe the folder as it was
    // and the drawer would keep offering a plugin that is gone. Queue instead of
    // dropping the request — one re-run when this one lands.
    if (! startScan (path))
        pendingManagedRescan = true;
}

bool PlectrifyEngine::startScan (const juce::FileSearchPath& paths)
{
    juce::WeakReference<PlectrifyEngine> safe (this);
    const auto refresh = [safe] (const juce::String& status, bool listChanged)
    {
        // Scan thread -> message thread. The queued lambda can land after
        // shutdown, hence the WeakReference.
        juce::MessageManager::callAsync ([safe, status, listChanged]
        {
            if (safe != nullptr)
            {
                // The full plugin-list payload only when the list actually
                // moved — an unchanged rescan is otherwise per-file spam.
                if (listChanged)
                    safe->emitPluginsChanged();
                safe->emitPluginScanChanged (status);
                if (status == "complete")
                {
                    safe->emitAppInfo();    // known/blacklisted counts moved
                    // A scan starts by blacklisting whatever the last one died
                    // on, so the list the UI shows can only be trusted after.
                    safe->emitPluginBlacklist();

                    // A full rescan covers the managed directory too, so it
                    // answers both requests and the narrow one is dropped.
                    if (std::exchange (safe->pendingFullRescan, false))
                    {
                        safe->pendingManagedRescan = false;
                        safe->scanForPlugins();
                    }
                    else if (std::exchange (safe->pendingManagedRescan, false))
                    {
                        safe->scanManagedPlugins();
                    }
                }
            }
        });
    };

    if (! pluginManager.scanAndAddPluginsAsync (paths,
                                                [refresh] (bool listChanged) { refresh ("scanning", listChanged); },
                                                [refresh] { refresh ("complete", true); }))
        return false;   // a scan is already running and keeps emitting its own progress

    emitPluginScanChanged ("scanning");
    return true;
}

void PlectrifyEngine::openEditorFor (juce::AudioProcessorGraph::NodeID nodeID)
{
    if (auto it = editorWindows.find (nodeID.uid); it != editorWindows.end())
    {
        it->second->toFront (true);
        return;
    }

    if (auto* instance = rack.getPluginInstance (nodeID))
    {
        juce::WeakReference<PlectrifyEngine> safeOwner (this);
        editorWindows[nodeID.uid] = std::make_unique<PluginEditorWindow> (
            *instance, [safeOwner, nodeID]
            {
                // PluginEditorWindow is executing closeButtonPressed() while
                // this callback runs. Erasing it synchronously would delete
                // `this` from inside its own virtual callback and can corrupt
                // the owning map. Return first, then destroy on the next turn.
                juce::MessageManager::callAsync ([safeOwner, nodeID]
                {
                    if (safeOwner != nullptr)
                        safeOwner->editorWindows.erase (nodeID.uid);
                });
            });
    }
}

// ---------------------------------------------------------------------------
// Host-saved state: the VST3 build's DAW-project persistence, and the
// engine-held session document its page uses in place of working-rack.json.
// ---------------------------------------------------------------------------
void PlectrifyEngine::handleWriteSession (const juce::var& payload)
{
    sessionBlob = payload["text"].toString();
    markHostStateDirty();
    // The plugin marks its host state dirty and pokes updateHostDisplay; the
    // standalone ignores it (its page writes working-rack.json instead and
    // never sends this event).
    host.engineSettingsChanged();

    // The same ack shape as fileWritten, so the page's persistence-notice
    // machinery is one path rather than two.
    auto* r = new juce::DynamicObject();
    r->setProperty ("requestId", payload["requestId"]);
    r->setProperty ("ok", true);
    emit ("sessionWritten", juce::var (r));
}

void PlectrifyEngine::handleReadSession (const juce::var& payload)
{
    auto* r = new juce::DynamicObject();
    r->setProperty ("requestId", payload["requestId"]);
    // Empty means "no session yet" — a fresh instance — which the page treats
    // exactly as a missing working-rack.json.
    r->setProperty ("ok", sessionBlob.isNotEmpty());
    r->setProperty ("text", sessionBlob);
    emit ("sessionRead", juce::var (r));
}

juce::String PlectrifyEngine::buildHostStateJson() const
{
    auto* state = new juce::DynamicObject();
    state->setProperty ("version", 1);
    // The rack in applyRigEntries' own shape, so applying a project is the
    // same code path as applying a rig or waking from a deep park.
    state->setProperty ("entries", captureRackEntries());
    state->setProperty ("routing", buildRoutingState());
    state->setProperty ("session", sessionBlob);

    // The fixed-node settings the standalone keeps in audio_settings.xml. No
    // inputSourceChannel: in a plugin that is pinned to 0 (the DAW routes).
    auto* fixed = new juce::DynamicObject();
    fixed->setProperty ("inputGainDb", rack.getInputGainDb());
    fixed->setProperty ("outputGainDb", rack.getOutputGainDb());
    fixed->setProperty ("tunerEnabled", rack.isTunerEnabled());
    // The guard's arming is a preference; its latch is not — same rule as
    // audio_settings.xml.
    fixed->setProperty ("feedbackGuardEnabled", rack.isFeedbackGuardEnabled());
    fixed->setProperty ("looperPostChain", rack.isLooperPostChain());
    fixed->setProperty ("looperArmEnabled", rack.isLooperArmEnabled());
    fixed->setProperty ("looperArmThresholdDb", rack.getLooperArmThresholdDb());
    fixed->setProperty ("metronomeBpm", rack.getMetronomeBpm());
    fixed->setProperty ("metronomeBeatsPerBar", rack.getMetronomeBeatsPerBar());
    fixed->setProperty ("metronomeSubdivision", rack.getMetronomeSubdivision());
    fixed->setProperty ("metronomePattern", plectrify::encodeMetronomePattern (
        rack.getMetronomeBeatPattern(), rack.getMetronomeBeatsPerBar()));
    fixed->setProperty ("metronomeLevelDb", rack.getMetronomeLevelDb());
    state->setProperty ("fixedNodes", juce::var (fixed));

    auto* editor = new juce::DynamicObject();
    editor->setProperty ("width", editorWidth);
    editor->setProperty ("height", editorHeight);
    state->setProperty ("editor", juce::var (editor));

    return juce::JSON::toString (juce::var (state), true);
}

void PlectrifyEngine::refreshHostStateCacheIfDue()
{
    // Never capture a half-built rack; the finished apply's rackChanged marks
    // the state dirty again, so nothing is lost by waiting.
    if (rigLoadInFlight || ! hostStateDirty.load (std::memory_order_acquire))
        return;

    const auto now = juce::Time::getMillisecondCounter();
    if (lastHostStateCaptureMs != 0 && now - lastHostStateCaptureMs < 2000)
        return;

    hostStateDirty.store (false, std::memory_order_release);
    lastHostStateCaptureMs = now;

    auto json = buildHostStateJson();
    const juce::ScopedLock l (hostStateLock);
    cachedHostState = std::move (json);
}

juce::String PlectrifyEngine::currentHostState()
{
    // On the message thread — where most hosts save — capture fresh, so the
    // answer is exact rather than up to ~2 s stale. Not during a rig load:
    // the cache still holds the last whole state, which is the honest answer
    // while the rack is half-built.
    if (juce::MessageManager::getInstance()->isThisTheMessageThread() && ! rigLoadInFlight)
    {
        hostStateDirty.store (false, std::memory_order_release);
        lastHostStateCaptureMs = juce::Time::getMillisecondCounter();
        auto json = buildHostStateJson();
        const juce::ScopedLock l (hostStateLock);
        cachedHostState = json;
        return json;
    }

    const juce::ScopedLock l (hostStateLock);
    return cachedHostState;
}

void PlectrifyEngine::applyHostState (const juce::String& json)
{
    const auto state = juce::JSON::parse (json);
    if (state.getDynamicObject() == nullptr)
        return;

    // The session lands before the rack rebuild: the page's readSession must
    // see the incoming document immediately, not the one being replaced.
    sessionBlob = state["session"].toString();

    if (auto* fixed = state["fixedNodes"].getDynamicObject())
    {
        const auto& fixedVar = state["fixedNodes"];
        // Absent fields leave the running value alone, the handleSetStatus
        // contract — an older state simply says less.
        if (fixed->hasProperty ("inputGainDb"))    rack.setInputGainDb ((float) (double) fixedVar["inputGainDb"]);
        if (fixed->hasProperty ("outputGainDb"))   rack.setOutputGainDb ((float) (double) fixedVar["outputGainDb"]);
        if (fixed->hasProperty ("tunerEnabled"))   rack.setTunerEnabled ((bool) fixedVar["tunerEnabled"]);
        if (fixed->hasProperty ("feedbackGuardEnabled"))
            rack.setFeedbackGuardEnabled ((bool) fixedVar["feedbackGuardEnabled"]);
        if (fixed->hasProperty ("looperPostChain"))
            rack.setLooperPostChain ((bool) fixedVar["looperPostChain"]);
        if (fixed->hasProperty ("looperArmEnabled"))
            rack.setLooperArmEnabled ((bool) fixedVar["looperArmEnabled"]);
        if (fixed->hasProperty ("looperArmThresholdDb"))
            rack.setLooperArmThresholdDb ((float) (double) fixedVar["looperArmThresholdDb"]);
        if (fixed->hasProperty ("metronomeBpm"))
            rack.setMetronomeBpm ((float) (double) fixedVar["metronomeBpm"]);
        if (fixed->hasProperty ("metronomeBeatsPerBar"))
            rack.setMetronomeBeatsPerBar ((int) fixedVar["metronomeBeatsPerBar"]);
        if (fixed->hasProperty ("metronomeSubdivision"))
            rack.setMetronomeSubdivision ((int) fixedVar["metronomeSubdivision"]);
        if (fixed->hasProperty ("metronomePattern"))
            rack.setMetronomeBeatPattern (plectrify::decodeMetronomePattern (
                fixedVar["metronomePattern"].toString()));
        if (fixed->hasProperty ("metronomeLevelDb"))
            rack.setMetronomeLevelDb ((float) (double) fixedVar["metronomeLevelDb"]);
        // metronomeEnabled is transient, exactly as it is across app launches.
    }

    if (state["editor"].getDynamicObject() != nullptr)
    {
        editorWidth  = juce::jlimit (760, 32768, (int) state["editor"]["width"]);
        editorHeight = juce::jlimit (480, 32768, (int) state["editor"]["height"]);
    }

    // The rack rebuilds through the ordinary rig-apply path: async plugin
    // creation under the load mute and its 120 s watchdog. A void requestId
    // means no page request awaits a reply (a project reload is the DAW's
    // doing) — the progress events still drive an attached page's busy state,
    // and missing plugins surface as missing modules rather than a modal.
    auto entries = std::make_shared<juce::Array<juce::var>> (
        state["entries"].getArray() != nullptr ? *state["entries"].getArray()
                                               : juce::Array<juce::var>{});
    const auto routing = state["routing"];
    auto failures = std::make_shared<juce::Array<juce::var>>();

    abandonStandby();
    const int loadGeneration = beginRigLoadMute();
    emitRigApplyProgress ({}, 0, entries->size());

    // Tell an attached page its session document changed under it, so it can
    // re-read and rejoin its metadata; a page loading later simply reads the
    // new document at boot. A superseding setStateInformation bumps the load
    // generation, so the older apply chain bails — the latest state wins.
    emit ("sessionChanged", juce::var());

    juce::WeakReference<PlectrifyEngine> safe (this);
    juce::Timer::callAfterDelay (50, [safe, entries, routing, failures, loadGeneration]
    {
        if (safe == nullptr)
            return;

        safe->tearDownRack();
        safe->applyRigEntries (entries, routing, 0, {}, failures, loadGeneration);
    });
}
