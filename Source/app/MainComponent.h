#pragma once

#include <JuceHeader.h>
#include "BackupArchive.h"
#include "HostServices.h"
#include "InputProbe.h"
#include "MidiInputManager.h"
#include "PlectrifyEngine.h"

#include <functional>
#include <memory>
#include <utility>
#include <vector>

/**
    The standalone application shell: everything around the engine that only
    exists because Plectrify is running as its own app rather than inside a DAW.
    It owns the audio device (AudioDeviceManager + AudioProcessorPlayer driving
    the engine's rack graph), the MIDI inputs, the window-facing handlers
    (resize handoff, theme mirroring) and the web view component itself — and it
    is the engine's HostServices, answering every device-shaped question
    PlectrifyEngine asks.

    Everything shared between the standalone and the VST3 plugin build — the
    rack, the plugin library, the whole UI bridge — lives in PlectrifyEngine.
*/
class MainComponent : public juce::Component,
                      public plectrify::HostServices,
                      private juce::ChangeListener
{
public:
    MainComponent();
    ~MainComponent() override;

    void resized() override;
    void parentHierarchyChanged() override; // navigate once we have a window peer

    /** Called on the message thread whenever the UI switches colour theme, so
        the window can repaint its native chrome to match. `true` means light.
        The window sets this; the UI pushes the theme on every settings write
        and once its settings file has loaded. */
    std::function<void (bool)> onWindowThemeChanged;

    // --- HostServices -----------------------------------------------------
    plectrify::HostCapabilities capabilities() const override { return {}; } // the standalone has it all
    /** Sample rate + block size of the current device, or sensible defaults. */
    std::pair<double, int> currentRateAndBlock() const override;
    double cpuLoad() const override { return deviceManager.getCpuUsage(); }
    int audioXRuns() const override;
    int deviceLatencySamples() const override;
    juce::var audioDeviceInfo() const override;
    bool blocksAutoStandby() const override;
    juce::StringArray midiDeviceNames() const override;
    void refreshMidiDevices() override;
    void onEngineTick() override;
    void handleOpenAudioSettings() override { showAudioSettings(); }
    void handleRequestAudioDevices (const juce::var& payload) override;
    /** Applies any subset of {driver, output device, input device, sample rate,
        buffer size, guitar channel}; absent fields leave that part alone, the
        same contract handleSetStatus and handleSetStandby use. Persists and
        re-pushes, so the page reconciles against what the driver actually did
        rather than against what it was asked for. */
    void handleSetAudioDevice (const juce::var& payload) override;
    /** Arms the per-channel input meters. Held by the setup wizard's input
        step alone: they are a second, independent tap of the raw device input
        and nothing else on screen needs them. */
    void handleWatchInputLevels (const juce::var& payload) override;
    // Kicks off the OS-native window-resize loop from an invisible edge strip
    // in the web UI (the WebView2 child window otherwise eats all mouse input,
    // leaving only the thin JUCE border as a resize grab zone).
    void handleStartWindowResize (const juce::var& payload) override;
    // The web UI's colour theme, mirrored onto the JUCE-drawn window chrome
    // (title bar, window controls, border) — the one part of the app the page's
    // CSS cannot reach.
    void handleSetWindowTheme (const juce::var& payload) override;
    // The user's rigs, patches, session and settings in and out of one archive
    // (Source/backup/BackupArchive.h). Standalone-only: the plugin declines
    // HostCapabilities::backup, so the page hides the rows and the engine drops
    // the events. Both open a native file dialog, do the work when it returns,
    // and report the outcome on the backupState stream.
    void handleCreateBackup (const juce::var& payload) override;
    void handleRestoreBackup (const juce::var& payload) override;

private:
    /** One backupState push. `phase` is one of the BackupPhase strings the page
        reduces over (see ui/src/lib/engine/backup.ts). */
    void emitBackupState (const juce::String& action, const juce::String& phase,
                          const plectrify::backup::Result& result);
    // The device manager broadcasts a change when the audio setup is edited
    // (buffer size, driver, device); the About block would otherwise keep
    // reporting the device that was open at boot.
    void changeListenerCallback (juce::ChangeBroadcaster* source) override;

    void showAudioSettings();

    juce::File getAudioSettingsFile() const;
    void saveAudioDeviceState();

    // --- Audio setup ------------------------------------------------------
    /** What a launch with no saved audio state opens.

        JUCE's default is the OS's default, which on Windows is shared-mode
        WASAPI on the built-in devices — a webcam microphone at thirty
        milliseconds. A guitarist hearing that first has already decided what
        the app is, so a fresh installation picks a driver family, a block size
        and every input channel for itself (see AudioSetupRules.h). Only ever
        called when audio_settings.xml is absent: an existing setup is the
        user's, however odd it looks from here. */
    void chooseFirstRunAudioDevice();

    /** Applies the rules to whatever device is open now: the recommended block
        size, and every input channel the interface has. */
    void applyRecommendedDeviceSetup();

    /** Switches on every input channel the open device has, if they are not on
        already (in which case nothing happens — reopening a device is a
        dropout).

        This is what makes the wizard's "plug in and play" step possible at all:
        a device callback only ever receives channels the device has switched
        on, so a jack left off cannot be metered, and a jack that cannot be
        metered cannot be offered as the one your guitar is in. Which one that
        is then becomes a graph edge (RackProcessor::setInputSourceChannel)
        rather than a device restart, so it is asked once and answered
        instantly for the rest of the session. */
    void enableAllInputChannels();

    /** The device choice as the page sees it: every driver family and its
        devices, what is open, the block sizes and rates it offers, and the
        names of its enabled input channels in the order the rack numbers them.
        Enumerating rescans the driver families, which is slow enough (ASIO
        loads each driver) that it happens on request rather than on a timer. */
    juce::var buildAudioDevicesState (bool rescan);
    void emitAudioDevices (bool rescan = false);
    void emitInputLevels();

    // --- Audio ------------------------------------------------------------
    juce::AudioDeviceManager   deviceManager;
    juce::AudioProcessorPlayer player;
    // A second device callback, beside the player, watching the input channels
    // the rack is not listening to. Silent by contract — see InputProbe.
    InputProbe                 inputProbe;
    // Scratch for the meters, reused so a 15 Hz push allocates nothing.
    std::vector<float>         inputLevelScratch;

    // --- The engine -------------------------------------------------------
    // Constructed before the web view (its event listeners go into the view's
    // options) and destroyed before it (the TONE3000 slice it owns holds a
    // second WebView2 environment on Windows).
    std::unique_ptr<PlectrifyEngine> engine;

    // Created after the web view (its callbacks emit bridge events); reset
    // first in the destructor so no MIDI callback can fire into teardown.
    std::unique_ptr<MidiInputManager> midi;

    // --- Web view ---------------------------------------------------------
    std::unique_ptr<juce::WebBrowserComponent> webView;
    bool navigationScheduled = false;

    // --- File dialogs -----------------------------------------------------
    // launchAsync returns immediately and calls back later, so the chooser has
    // to outlive the call that made it. One member rather than one per
    // operation: only one dialog is ever open, and replacing it here is what
    // releases the last one.
    std::unique_ptr<juce::FileChooser> fileChooser;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
