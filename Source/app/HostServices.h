#pragma once

#include <JuceHeader.h>

#include <utility>

/**
    The engine's only route to anything host-shaped.

    PlectrifyEngine owns the rack, the plugin library, the catalogue, the
    TONE3000 slice and the whole UI bridge — everything that is the same
    whether Plectrify runs as the standalone app or as a VST3 plugin. What
    differs is who owns the audio device, the MIDI inputs and the window, and
    every one of those questions is asked through this interface: the
    standalone shell (MainComponent) answers from its AudioDeviceManager, the
    plugin processor answers from what its DAW host gave it.

    All methods are called on the message thread.
*/
namespace plectrify
{

/** Which host-owned facilities exist around the engine. Pushed to the page
    (as part of appInfo) so standalone-only panels — the setup wizard, the
    audio-device settings, window chrome, Auto Standby — can hide themselves
    where the host owns those concerns. Defaults describe the standalone. */
struct HostCapabilities
{
    bool audioDevices = true;   ///< device picker, setup wizard, Advanced audio…
    bool midiDevices  = true;   ///< MIDI device list (the event stream flows regardless)
    bool windowChrome = true;   ///< resize handles, window theme mirroring
    bool autoStandby  = true;   ///< the idle park/wake machinery

    // Backup, restore and reset of the per-user data root. Declined by the
    // plugin: what a DAW session owns rides its project document, so a panel
    // there would offer to archive rigs and settings the session is not using
    // and to replace — or erase — them under every other instance at once.
    bool backup = true;         ///< the Settings panel's backup/restore/reset rows

    // The three practice tools. Each is a fixed graph node plus a panel, and
    // each is declined by the plugin for a reason of its own — see
    // PlectrifyAudioProcessor::capabilities(). Declining one drops the node from
    // the chain as well as the surface: a looper that is merely hidden still
    // costs its 46 MB of loop buffer per instance.
    bool looper        = true;  ///< the loop recorder and its session archive
    bool metronome     = true;  ///< the practice click
    bool feedbackGuard = true;  ///< the acoustic-feedback detector and its latch

    // Installing a newer Plectrify from inside the app: download the
    // installer, verify it, run it silently, quit, come back as the new
    // version (Source/update/UpdateInstaller.h). Windows standalone only. The
    // plugin cannot quit the DAW, and the installer replaces the very bundle
    // the DAW has loaded; macOS has no silent pkg path and Linux updates
    // through APT — the page keeps its "Download"/"What's new" button there.
   #if JUCE_WINDOWS
    bool selfUpdate = true;     ///< the update notice's Install button
   #else
    bool selfUpdate = false;
   #endif

    // The Linux counterpart: nothing is downloaded there, since the .deb
    // registers Plectrify's APT repository and the system installs the update.
    // What the host offers instead is what APT's index knows and a hand-off
    // to the desktop's updater (Source/update/SystemUpdateChannel.h). Linux
    // standalone only: the updater would replace the .vst3 a DAW has loaded.
   #if JUCE_LINUX
    bool systemUpdates = true;  ///< the update notice's Open updater button
   #else
    bool systemUpdates = false;
   #endif
};

class HostServices
{
public:
    virtual ~HostServices() = default;

    virtual HostCapabilities capabilities() const = 0;

    /** Which binary this engine is running inside, exactly as the page's
        AppInfo reports it. */
    virtual const char* hostKind() const { return "standalone"; }

    /** True where the host persists the engine's state itself (the VST3, whose
        DAW project carries it). Gates the engine's periodic state-capture
        cache, which serializes every hosted plugin's state and therefore must
        not run in the standalone for nothing. */
    virtual bool capturesHostState() const { return false; }

    /** Sample rate + block size plugins are instantiated at: the open device's
        in the app, the host's prepareToPlay values in a plugin — or sensible
        defaults while neither exists yet. */
    virtual std::pair<double, int> currentRateAndBlock() const = 0;

    /** CPU load fraction for the status payload's readout. */
    virtual double cpuLoad() const = 0;

    /** Driver dropout count, or -1 where nothing can count them. */
    virtual int audioXRuns() const = 0;

    /** Converter/driver input+output latency in samples, or -1 when no device
        is open. The engine adds the chain's own latency on top for the status
        payload's round-trip figure. */
    virtual int deviceLatencySamples() const = 0;

    /** The About dialog's audio-device group (driver, device, bit depth,
        channel counts, latencies), or void when no device is open — the report
        then dashes those rows out rather than describing a device that isn't. */
    virtual juce::var audioDeviceInfo() const = 0;

    /** Host-side reasons Auto Standby may not engage: no device open (the
        detector would read permanent silence), or the setup wizard's input
        meters armed (silence there is the question being answered). The engine
        contributes its own reasons — scans, installs, editors, modals — in
        PlectrifyEngine::standbyIsBlocked(). */
    virtual bool blocksAutoStandby() const = 0;

    /** MIDI input device names for the page's MIDI dialog. Empty where the
        host owns MIDI routing (a DAW). */
    virtual juce::StringArray midiDeviceNames() const { return {}; }

    /** Re-enumerates MIDI devices before the engine answers requestMidiDevices,
        so the reply reflects this instant rather than a hot-plug poll's last
        pass. */
    virtual void refreshMidiDevices() {}

    /** The graph's total latency moved — a plugin toggled oversampling, or the
        chain itself changed. The standalone needs nothing (the figure already
        rides the status payload); the plugin reports it to its DAW host. */
    virtual void graphLatencyChanged (int totalLatencySamples) { juce::ignoreUnused (totalLatencySamples); }

    /** A fixed-node/engine setting changed (gains, tuner, looper and metronome
        preferences). The standalone persists them at exit into
        audio_settings.xml; the plugin marks its host-saved state dirty. */
    virtual void engineSettingsChanged() {}

    /** One 15 Hz engine tick. Called with no web view attached as well, so an
        implementation that drains a queue keeps draining it — which is the
        plugin's, flushing host MIDI. Anything emitted from here no-ops while
        detached. The standalone emits the setup wizard's input meters here
        while they are armed. */
    virtual void onEngineTick() {}

    // --- Bridge events only a host can answer ------------------------------
    // Registered by the engine, delegated here; hosts without the facility
    // inherit the harmless no-op and the page hides the surface behind
    // HostCapabilities.
    virtual void handleOpenAudioSettings() {}
    virtual void handleRequestAudioDevices (const juce::var&) {}
    virtual void handleSetAudioDevice (const juce::var&) {}
    virtual void handleWatchInputLevels (const juce::var&) {}
    virtual void handleStartWindowResize (const juce::var&) {}
    // Both open a native file dialog and then do the work on the message
    // thread — see Source/backup/BackupArchive.h. The page names no path in
    // either direction: it asks, the user picks in an OS dialog, so
    // PlectrifyEngine::resolveAppFile's promise that nothing the web page asks
    // for reaches outside the data root is untouched.
    virtual void handleCreateBackup (const juce::var&) {}
    virtual void handleRestoreBackup (const juce::var&) {}
    // Schedules a reset of the data root (Source/backup/AppReset.h) and
    // restarts the app, which clears it on the way back up. Gated with the two
    // above, and for the same reason.
    virtual void handleResetApp (const juce::var&) {}
    // The page asking, on boot, for anything the backupState stream still owes
    // it: a reset the previous launch could not finish is reported here, since
    // the push that would have said so predates the page.
    virtual void handleRequestBackupState() {}
    // The in-app update (HostCapabilities::selfUpdate): start the download-
    // verify-install run, call a download off, and replay the stream's last
    // state to a page that has just (re)loaded — a download outlives a page
    // reload, and the push that said where it stood predates the new page.
    virtual void handleInstallUpdate (const juce::var&) {}
    virtual void handleCancelUpdateInstall() {}
    virtual void handleRequestUpdateInstallState() {}
    // The Linux notice's helpers (HostCapabilities::systemUpdates): what APT's
    // index knows (asked on boot and whenever the notice wants it fresh) and
    // the desktop's updater. Both answer on the updateChannel stream.
    virtual void handleRequestUpdateChannel() {}
    virtual void handleOpenSystemUpdater() {}
    virtual void handleSetWindowTheme (const juce::var&) {}
    // The inverse gate of the two above: served by the plugin, no-op in the
    // standalone (whose window the OS resizes). AUv2 gives a host no way to
    // learn the view is resizable, so no AU host offers frame dragging — the
    // page draws its own resize handles in plugin mode and drives the size
    // through here.
    virtual void handleSetEditorSize (const juce::var&) {}
};

} // namespace plectrify
