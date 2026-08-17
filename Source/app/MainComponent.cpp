#include "MainComponent.h"
#include "AppPaths.h"
#include "AudioSetupRules.h"
#include "EngineHelpers.h"
#include "EngineWebView.h"

#if JUCE_WINDOWS
 // For the WM_NCLBUTTONDOWN sizing-loop handoff in handleStartWindowResize.
 #include <windows.h>
#else
 #include "WindowResizeDriver.h"
#endif

#include <map>

namespace
{
   #if JUCE_WINDOWS
    // The audio half of AudioDeviceManager::initialiseFromXML. Passing the
    // saved XML to initialise() itself would end in openLastRequestedMidiDevices,
    // whose system MIDI enumeration crashes the process inside JUCE 8.0.14's
    // Windows UMP backend on current Windows 11 builds. Plectrify uses no MIDI,
    // so the setup is restored by hand and the MIDI path is never entered.
    // Windows-only: other platforms restore through the stock initialise()
    // path, whose MIDI enumeration is safe there.
    juce::AudioDeviceManager::AudioDeviceSetup audioSetupFromXml (const juce::XmlElement& xml)
    {
        juce::AudioDeviceManager::AudioDeviceSetup setup;

        if (xml.getStringAttribute ("audioDeviceName").isNotEmpty())
        {
            setup.inputDeviceName = setup.outputDeviceName = xml.getStringAttribute ("audioDeviceName");
        }
        else
        {
            setup.inputDeviceName  = xml.getStringAttribute ("audioInputDeviceName");
            setup.outputDeviceName = xml.getStringAttribute ("audioOutputDeviceName");
        }

        setup.bufferSize = xml.getIntAttribute ("audioDeviceBufferSize", setup.bufferSize);
        setup.sampleRate = xml.getDoubleAttribute ("audioDeviceRate", setup.sampleRate);

        setup.inputChannels .parseString (xml.getStringAttribute ("audioDeviceInChans",  "11"), 2);
        setup.outputChannels.parseString (xml.getStringAttribute ("audioDeviceOutChans", "11"), 2);
        setup.useDefaultInputChannels  = ! xml.hasAttribute ("audioDeviceInChans");
        setup.useDefaultOutputChannels = ! xml.hasAttribute ("audioDeviceOutChans");

        return setup;
    }
   #endif

    /** The device's enabled input channels, in the order the graph's input node
        exposes them — which is the order the rack's channel index counts in.
        getInputChannelNames() lists every jack the interface has; the active
        mask says which of them are actually there to be read. */
    juce::StringArray activeInputChannelNames (juce::AudioIODevice& device)
    {
        const auto names = device.getInputChannelNames();
        const auto active = device.getActiveInputChannels();

        juce::StringArray enabled;
        for (int channel = 0; channel < names.size(); ++channel)
            if (active[channel])
                enabled.add (names[channel]);

        return enabled;
    }
}

MainComponent::MainComponent()
{
    // --- Audio device: restore the last-used setup if we have one ---------
    std::unique_ptr<juce::XmlElement> savedState;
    if (auto file = getAudioSettingsFile(); file.existsAsFile())
        savedState = juce::XmlDocument::parse (file);

    if (savedState != nullptr)
    {
       #if JUCE_WINDOWS
        // Creates and scans the device types without opening a device, so the
        // type switch below never closes a running device (which would cost a
        // 1.5 s settling sleep inside setCurrentAudioDeviceType).
        deviceManager.getAvailableDeviceTypes();
        deviceManager.setCurrentAudioDeviceType (savedState->getStringAttribute ("deviceType"), true);

        if (deviceManager.setAudioDeviceSetup (audioSetupFromXml (*savedState), true).isNotEmpty())
            deviceManager.initialise (2, 2, nullptr, true); // saved device gone: fall back to defaults
       #else
        // Stock restore path — audioSetupFromXml exists only to dodge a
        // Windows-only JUCE 8.0.14 MIDI crash. Going through initialise() here
        // also restores the saved MIDI device state, which the hand-rolled
        // path deliberately skips.
        if (deviceManager.initialise (2, 2, savedState.get(), true).isNotEmpty())
            deviceManager.initialise (2, 2, nullptr, true); // saved device gone: fall back to defaults
       #endif
    }
    else
    {
        chooseFirstRunAudioDevice();
    }

    // The engine owns the rack, so it exists before the saved rack settings
    // are applied — and before the web view, whose options carry its event
    // listeners.
    engine = std::make_unique<PlectrifyEngine> (*this);
    auto& rack = engine->getRack();

    if (savedState != nullptr)
    {
        // Before the gains: it is a graph edit, and doing it while the rack is
        // still empty costs one rebuild of nothing.
        rack.setInputSourceChannel (savedState->getIntAttribute ("inputSourceChannel", 0));
        rack.setInputGainDb ((float) savedState->getDoubleAttribute ("inputGainDb", 0.0));
        rack.setOutputGainDb ((float) savedState->getDoubleAttribute ("outputGainDb", 0.0));
        rack.setTunerEnabled (savedState->getBoolAttribute ("tunerEnabled", true));
        rack.setFeedbackGuardEnabled (savedState->getBoolAttribute ("feedbackGuardEnabled", false));
        rack.setLooperPostChain (savedState->getBoolAttribute ("looperPostChain", true));
        rack.setLooperArmEnabled (savedState->getBoolAttribute ("looperArmEnabled", true));
        rack.setLooperArmThresholdDb ((float) savedState->getDoubleAttribute (
            "looperArmThresholdDb", LooperProcessor::defaultArmThresholdDb));
        rack.setMetronomeBpm ((float) savedState->getDoubleAttribute (
            "metronomeBpm", MetronomeProcessor::defaultBpm));
        rack.setMetronomeBeatsPerBar (savedState->getIntAttribute (
            "metronomeBeatsPerBar", MetronomeProcessor::defaultBeatsPerBar));
        rack.setMetronomeSubdivision (savedState->getIntAttribute ("metronomeSubdivision", 1));
        rack.setMetronomeLevelDb ((float) savedState->getDoubleAttribute (
            "metronomeLevelDb", MetronomeProcessor::defaultLevelDb));
        rack.setMetronomeBeatPattern (plectrify::decodeMetronomePattern (
            savedState->getStringAttribute ("metronomePattern")));
        // Enabled is deliberately transient: a restored rig must never start
        // clicking merely because it was running when the app last closed.
    }
    player.setProcessor (&rack.getGraph());
    deviceManager.addAudioCallback (&player);
    // After the player, so the probe is one of the callbacks whose output is
    // summed rather than the one that writes the device buffer. Either order
    // works — the probe writes silence regardless — but this way the rig's
    // audio is never a summand of anything.
    deviceManager.addAudioCallback (&inputProbe);
    deviceManager.addChangeListener (this); // keeps the About diagnostics' device rows current

    // --- Web view + event-only bridge to the engine -----------------------
    const auto options = engine->registerEventListeners (
        plectrify::makeEngineWebViewOptions (plectrify::appDataDir().getChildFile ("WebView2")));

    webView = std::make_unique<plectrify::AmpWebBrowserComponent> (options);
    addAndMakeVisible (*webView);
    engine->attachWebView (webView.get());

    // --- MIDI inputs (all of them, hot-plug included) ---------------------
    // A footswitch press is user intent even while the rig is parked: it
    // counts as standby activity, so the first press wakes and the UI acts on
    // the next one (the UI suppresses actions until the stage is 'active').
    midi = std::make_unique<MidiInputManager> (
        [this] (const juce::var& events)
        {
            engine->noteStandbyActivity();
            engine->emit ("midiEvents", events);
        },
        [this] (const juce::StringArray&) { engine->emitMidiDevices(); });

    // Navigation is deferred to parentHierarchyChanged(): WebView2 needs a real
    // window peer, which this component doesn't have until it's added to the
    // MainWindow. Navigating too early yields "navigation cancelled".
    setSize (1040, 640);
}

MainComponent::~MainComponent()
{
    // Close the MIDI inputs first: their callbacks emit bridge events and must
    // not fire into a WebView or rack that is being torn down.
    midi.reset();

    // Detach and stop audio *before* tearing anything else down: stop the
    // device callbacks, unhook the player from the graph, and close the device
    // so no audio-thread work can be in flight while the WebView (async COM
    // teardown) and the rest of the stack are destroyed.
    deviceManager.removeChangeListener (this);
    deviceManager.removeAudioCallback (&inputProbe);
    deviceManager.removeAudioCallback (&player);
    player.setProcessor (nullptr);
    saveAudioDeviceState();       // capture setup while the engine's rack is still alive
    deviceManager.closeAudioDevice();

    // The engine detaches plugin listeners, closes editor windows and tears
    // down the TONE3000 slice — and it must go before the web view: on Windows
    // the sign-in window owns a second WebView2 environment, and two of them
    // tearing down COM at once is the failure this ordering avoids.
    engine.reset();
    webView.reset();
}

void MainComponent::resized()
{
    if (webView != nullptr)
        webView->setBounds (getLocalBounds());
}

void MainComponent::parentHierarchyChanged()
{
    if (navigationScheduled || webView == nullptr || getPeer() == nullptr)
        return;

    navigationScheduled = true;

    // Defer the first navigation slightly: WebView2 initialises asynchronously
    // once the component has a window peer, and navigating before its resource
    // filter is registered aborts the load (OPERATION_CANCELED / can't reach).
    juce::Component::SafePointer<MainComponent> safe (this);
    juce::Timer::callAfterDelay (500, [safe]
    {
        if (safe == nullptr || safe->webView == nullptr)
            return;

        safe->webView->goToURL (plectrify::uiNavigationTarget());
        safe->engine->startTicking(); // safe now that goToURL has been called at least once
    });
}

// ---------------------------------------------------------------------------
// HostServices — the standalone's answers to the engine's device questions.
// ---------------------------------------------------------------------------
std::pair<double, int> MainComponent::currentRateAndBlock() const
{
    if (auto* device = deviceManager.getCurrentAudioDevice())
        return { device->getCurrentSampleRate(), device->getCurrentBufferSizeSamples() };
    return { 44100.0, 512 };
}

int MainComponent::audioXRuns() const
{
    // JUCE reports -1 for a driver that cannot count xruns, which the UI shows
    // as unknown rather than as zero.
    if (auto* device = deviceManager.getCurrentAudioDevice())
        return device->getXRunCount();
    return -1;
}

int MainComponent::deviceLatencySamples() const
{
    if (auto* device = deviceManager.getCurrentAudioDevice())
        return device->getInputLatencyInSamples() + device->getOutputLatencyInSamples();
    return -1;
}

juce::var MainComponent::audioDeviceInfo() const
{
    // Rate and buffer stay in the live status payload rather than being
    // duplicated here, so the About report has exactly one source for each
    // number. Void when no device is open.
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr)
        return {};

    auto* audio = new juce::DynamicObject();
    audio->setProperty ("driverType", device->getTypeName());
    audio->setProperty ("deviceName", device->getName());
    audio->setProperty ("bitDepth", device->getCurrentBitDepth());
    audio->setProperty ("inputChannels", device->getActiveInputChannels().countNumberOfSetBits());
    audio->setProperty ("outputChannels", device->getActiveOutputChannels().countNumberOfSetBits());
    audio->setProperty ("inputLatencySamples", device->getInputLatencyInSamples());
    audio->setProperty ("outputLatencySamples", device->getOutputLatencyInSamples());
    return juce::var (audio);
}

bool MainComponent::blocksAutoStandby() const
{
    // No device means no peaks arrive at all, so the detector would read
    // permanent silence and park a rig the user can't even hear yet.
    if (deviceManager.getCurrentAudioDevice() == nullptr)
        return true;

    // The setup wizard's input step asks the player to hold a guitar and strum
    // while it watches. Silence there is the question being answered, not an
    // idle rig — and the meters it is reading are the first thing a park would
    // stop feeding.
    return inputProbe.isWatching();
}

juce::StringArray MainComponent::midiDeviceNames() const
{
    return midi != nullptr ? midi->openDeviceNames() : juce::StringArray{};
}

void MainComponent::refreshMidiDevices()
{
    if (midi != nullptr)
        midi->refreshDevices();
}

void MainComponent::onEngineTick()
{
    // Only while the setup wizard's input step is open, which is the only thing
    // that ever asks: the meters are a second tap of the raw device input, and
    // an ordinary session has no use for the channels the rack is not on.
    if (inputProbe.isWatching())
        emitInputLevels();
}

void MainComponent::handleRequestAudioDevices (const juce::var& payload)
{
    emitAudioDevices ((bool) payload.getProperty ("rescan", false));
}

void MainComponent::changeListenerCallback (juce::ChangeBroadcaster* source)
{
    if (source == &deviceManager)
    {
        engine->emitAppInfo();
        // The native settings dialog writes through the same device manager, so
        // this is also how a wizard left open behind it learns that the device,
        // the block size or the enabled channels have moved under it.
        emitAudioDevices();
    }
}

void MainComponent::handleSetWindowTheme (const juce::var& payload)
{
    if (onWindowThemeChanged != nullptr)
        onWindowThemeChanged (payload["theme"].toString() == "light");
}

void MainComponent::handleStartWindowResize (const juce::var& payload)
{
   #if JUCE_WINDOWS
    static const std::map<juce::String, WPARAM> hitCodes {
        { "left",         HTLEFT },
        { "right",        HTRIGHT },
        { "top",          HTTOP },
        { "top-left",     HTTOPLEFT },
        { "top-right",    HTTOPRIGHT },
        { "bottom",       HTBOTTOM },
        { "bottom-left",  HTBOTTOMLEFT },
        { "bottom-right", HTBOTTOMRIGHT },
    };
    const auto hit = hitCodes.find (payload["edge"].toString());
    if (hit == hitCodes.end())
        return;

    auto* peer = getPeer();
    if (peer == nullptr)
        return;

    // Hand the drag to the OS: releasing WebView2's mouse capture and posting a
    // non-client click makes DefWindowProc run its native sizing loop, exactly
    // as if the user had grabbed a real window border.
    POINT cursorPosition {};
    GetCursorPos (&cursorPosition);
    ReleaseCapture();
    PostMessage (static_cast<HWND> (peer->getNativeHandle()), WM_NCLBUTTONDOWN,
                 hit->second, MAKELPARAM (cursorPosition.x, cursorPosition.y));
   #else
    // No OS sizing-loop handoff outside Windows: the drag's mouse events all
    // go to the web view, so WindowResizeDriver polls the global mouse from a
    // timer and resizes through the window's constrainer (resize limits hold).
    WindowResizeDriver::start (*this, payload["edge"].toString());
   #endif
}

// ---------------------------------------------------------------------------
// Audio setup: what a first launch opens, and the device choice as the setup
// wizard sees it. The native AudioDeviceSelectorComponent below is still there
// for everything this does not cover (channel masks, MIDI, exclusive modes),
// but nothing about it is a first impression anyone should have to survive.
// ---------------------------------------------------------------------------
void MainComponent::chooseFirstRunAudioDevice()
{
    // Open *something* first: the type switch below wants a device to fall back
    // to, and a machine with no ASIO at all is finished after this line.
    deviceManager.initialise (2, 2, nullptr, true);

    juce::StringArray typeNames;
    for (auto* type : deviceManager.getAvailableDeviceTypes())
        typeNames.add (type->getTypeName());

    const auto fallback = deviceManager.getCurrentAudioDeviceType();
    const auto preferred = plectrify::audiosetup::preferredDeviceType (typeNames);

    if (preferred.isNotEmpty() && preferred != fallback)
    {
        deviceManager.setCurrentAudioDeviceType (preferred, true);

        // A driver that is listed is not a driver that opens: an interface can
        // be unplugged, or held exclusively by another host that is still
        // running. A first launch with the wrong device beats a first launch
        // with no audio at all, so this goes back rather than leaving nothing.
        if (deviceManager.getCurrentAudioDevice() == nullptr)
            deviceManager.setCurrentAudioDeviceType (fallback, true);
    }

    applyRecommendedDeviceSetup();
}

void MainComponent::applyRecommendedDeviceSetup()
{
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr)
        return;

    auto setup = deviceManager.getAudioDeviceSetup();

    if (const auto buffer = plectrify::audiosetup::preferredBufferSize (
            device->getAvailableBufferSizes(), device->getCurrentSampleRate());
        buffer > 0)
        setup.bufferSize = buffer;

    if (const auto inputs = device->getInputChannelNames().size(); inputs > 0)
    {
        setup.inputChannels.clear();
        setup.inputChannels.setRange (0, inputs, true);
        setup.useDefaultInputChannels = false;
    }

    deviceManager.setAudioDeviceSetup (setup, true);
}

void MainComponent::enableAllInputChannels()
{
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr)
        return;

    // Exactly the channels this interface has, counted from the device rather
    // than set generously and left to be clamped: JUCE's Windows backends size
    // their channel map from the highest set bit, so a mask claiming channels
    // that are not there is read as channels that are.
    const auto inputs = device->getInputChannelNames().size();
    auto setup = deviceManager.getAudioDeviceSetup();
    if (inputs <= 0 || setup.inputChannels.countNumberOfSetBits() >= inputs)
        return;   // already all on — and reopening a device costs a dropout

    setup.inputChannels.clear();
    setup.inputChannels.setRange (0, inputs, true);
    setup.useDefaultInputChannels = false;
    deviceManager.setAudioDeviceSetup (setup, true);
}

juce::var MainComponent::buildAudioDevicesState (bool rescan)
{
    auto* state = new juce::DynamicObject();

    juce::Array<juce::var> drivers;
    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        // Only when asked: on Windows this opens every installed ASIO driver in
        // turn, which takes long enough to be felt and can pop up a vendor's
        // own dialog. The wizard asks when it opens and when the user presses
        // Refresh, which is exactly when a newly plugged-in interface matters.
        if (rescan)
            type->scanForDevices();

        auto* driver = new juce::DynamicObject();
        driver->setProperty ("name", type->getTypeName());
        driver->setProperty ("separateInputsAndOutputs", type->hasSeparateInputsAndOutputs());
        driver->setProperty ("outputDevices", plectrify::toVarArray (type->getDeviceNames (false)));
        driver->setProperty ("inputDevices", plectrify::toVarArray (type->getDeviceNames (true)));
        drivers.add (juce::var (driver));
    }
    state->setProperty ("drivers", juce::var (std::move (drivers)));

    const auto setup = deviceManager.getAudioDeviceSetup();
    state->setProperty ("driver", deviceManager.getCurrentAudioDeviceType());
    state->setProperty ("outputDevice", setup.outputDeviceName);
    state->setProperty ("inputDevice", setup.inputDeviceName);
    state->setProperty ("inputChannel", engine->getRack().getInputSourceChannel());

    juce::Array<juce::var> bufferSizes, sampleRates;
    juce::StringArray inputChannels;
    auto* device = deviceManager.getCurrentAudioDevice();

    if (device != nullptr)
    {
        for (const auto size : device->getAvailableBufferSizes())
            bufferSizes.add (size);
        for (const auto rate : device->getAvailableSampleRates())
            sampleRates.add (rate);

        inputChannels = activeInputChannelNames (*device);

        state->setProperty ("sampleRate", device->getCurrentSampleRate());
        state->setProperty ("bufferSize", device->getCurrentBufferSizeSamples());
        state->setProperty ("recommendedBufferSize", plectrify::audiosetup::preferredBufferSize (
            device->getAvailableBufferSizes(), device->getCurrentSampleRate()));
        state->setProperty ("deviceLatencySamples",
                            device->getInputLatencyInSamples() + device->getOutputLatencyInSamples());
    }
    else
    {
        // No device: the page needs the driver lists (that is how the user gets
        // one open again) and nothing else. Rates and sizes belong to a device.
        state->setProperty ("sampleRate", 0.0);
        state->setProperty ("bufferSize", 0);
        state->setProperty ("recommendedBufferSize", 0);
        state->setProperty ("deviceLatencySamples", -1);
    }

    state->setProperty ("open", device != nullptr);
    state->setProperty ("bufferSizes", juce::var (std::move (bufferSizes)));
    state->setProperty ("sampleRates", juce::var (std::move (sampleRates)));
    state->setProperty ("inputChannels", plectrify::toVarArray (inputChannels));

    return juce::var (state);
}

void MainComponent::emitAudioDevices (bool rescan)
{
    engine->emit ("audioDevicesChanged", buildAudioDevicesState (rescan));
}

void MainComponent::handleSetAudioDevice (const juce::var& payload)
{
    auto* object = payload.getDynamicObject();
    if (object == nullptr)
        return;

    // The driver family first and on its own: switching it closes the old
    // device and opens that family's default, so every name below has to be
    // read against the setup that leaves behind rather than the one before it.
    if (object->hasProperty ("driver"))
    {
        const auto driver = payload["driver"].toString();
        if (driver.isNotEmpty() && driver != deviceManager.getCurrentAudioDeviceType())
        {
            deviceManager.setCurrentAudioDeviceType (driver, true);
            // A family the user chose deliberately still gets the rules applied
            // to whatever it opened, so its default is a playable one.
            applyRecommendedDeviceSetup();
        }
    }

    auto setup = deviceManager.getAudioDeviceSetup();
    bool changed = false;

    // Absent fields mean "leave unchanged", matching handleSetStatus.
    if (object->hasProperty ("outputDevice"))
    {
        setup.outputDeviceName = payload["outputDevice"].toString();
        changed = true;
    }
    if (object->hasProperty ("inputDevice"))
    {
        setup.inputDeviceName = payload["inputDevice"].toString();
        changed = true;
    }
    if (object->hasProperty ("sampleRate"))
    {
        setup.sampleRate = (double) payload["sampleRate"];
        changed = true;
    }
    if (object->hasProperty ("bufferSize"))
    {
        setup.bufferSize = (int) payload["bufferSize"];
        changed = true;
    }

    if (changed)
    {
        deviceManager.setAudioDeviceSetup (setup, true);
        // Only now: a device that has just been named has to be open before it
        // can say how many inputs it has. Skipped outright when they are all on
        // already, which is the usual case and is why changing a block size
        // does not reopen anything twice.
        enableAllInputChannels();
    }

    // Last, and after any device change: the channel is an index into what the
    // device now offers, so applying it against the old one could name a jack
    // that has just gone.
    if (object->hasProperty ("inputChannel"))
        engine->getRack().setInputSourceChannel ((int) payload["inputChannel"]);

    saveAudioDeviceState();
    // The device is the page's own choice, so it reconciles against what the
    // driver actually did — a requested rate or block size the hardware refused
    // comes back as the one it settled on.
    emitAudioDevices();
    engine->emitAppInfo();
    engine->emitStatusChanged();
}

void MainComponent::handleWatchInputLevels (const juce::var& payload)
{
    inputProbe.setWatching ((bool) payload.getProperty ("watching", false));
}

void MainComponent::emitInputLevels()
{
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr)
        return;

    inputProbe.readPeaks (inputLevelScratch, device->getActiveInputChannels().countNumberOfSetBits());

    juce::Array<juce::var> peaks;
    for (const auto peak : inputLevelScratch)
        peaks.add (peak);

    auto* state = new juce::DynamicObject();
    state->setProperty ("peaks", juce::var (std::move (peaks)));
    engine->emit ("inputLevels", juce::var (state));
}

void MainComponent::showAudioSettings()
{
    auto selector = std::make_unique<juce::AudioDeviceSelectorComponent> (
        deviceManager, 1, 2, 1, 2, false, false, false, false);
    selector->setSize (450, 380);

    juce::DialogWindow::LaunchOptions options;
    options.content.setOwned (selector.release());
    options.dialogTitle                  = "Audio Settings";
    options.dialogBackgroundColour       = juce::Colours::darkgrey;
    options.escapeKeyTriggersCloseButton = true;
    options.useNativeTitleBar            = true;
    options.resizable                    = false;
    options.launchAsync();
}

// ---------------------------------------------------------------------------
juce::File MainComponent::getAudioSettingsFile() const
{
    return plectrify::appDataDir().getChildFile ("audio_settings.xml");
}

void MainComponent::saveAudioDeviceState()
{
    if (auto xml = deviceManager.createStateXml())
    {
        auto& rack = engine->getRack();

        // Which jack the guitar is in. Beside the device rather than in
        // settings.json because it only means anything against this device's
        // channel list, and both are restored together.
        xml->setAttribute ("inputSourceChannel", rack.getInputSourceChannel());
        xml->setAttribute ("inputGainDb", rack.getInputGainDb());
        xml->setAttribute ("outputGainDb", rack.getOutputGainDb());
        xml->setAttribute ("tunerEnabled", rack.isTunerEnabled());
        // The guard's arming is a preference; its latch is not. Restoring a mute
        // from a session that ended hours ago would only look like a dead rig.
        xml->setAttribute ("feedbackGuardEnabled", rack.isFeedbackGuardEnabled());
        xml->setAttribute ("looperPostChain", rack.isLooperPostChain());
        xml->setAttribute ("looperArmEnabled", rack.isLooperArmEnabled());
        xml->setAttribute ("looperArmThresholdDb", rack.getLooperArmThresholdDb());
        xml->setAttribute ("metronomeBpm", rack.getMetronomeBpm());
        xml->setAttribute ("metronomeBeatsPerBar", rack.getMetronomeBeatsPerBar());
        xml->setAttribute ("metronomeSubdivision", rack.getMetronomeSubdivision());
        xml->setAttribute ("metronomePattern", plectrify::encodeMetronomePattern (
            rack.getMetronomeBeatPattern(), rack.getMetronomeBeatsPerBar()));
        xml->setAttribute ("metronomeLevelDb", rack.getMetronomeLevelDb());
        // metronomeEnabled is intentionally not persisted.
        auto file = getAudioSettingsFile();
        file.getParentDirectory().createDirectory();
        xml->writeTo (file);
    }
}
