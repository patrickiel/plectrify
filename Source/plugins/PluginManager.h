#pragma once

#include <JuceHeader.h>

#include <atomic>
#include <functional>

/**
    Knows which VST3 plugins exist on this machine and how to instantiate them.

    Owns the format manager (VST3 only for now) and a KnownPluginList that is
    cached to disk, so scanning is a one-off cost rather than a per-launch one.
    Scanning instantiates each plugin in-process, so it runs on a background
    thread — a slow or hanging plugin must never freeze the UI — protected by a
    dead-man's-pedal file so a plugin that crashes the app is blacklisted and
    skipped on the next run. KnownPluginList is internally locked, so the
    message thread may read it (getTypes() returns a copy) while a scan runs.
    Instantiation is asynchronous because some formats must be created on the
    message thread.
*/
class PluginManager : private juce::Thread
{
public:
    PluginManager();
    ~PluginManager() override;

    juce::KnownPluginList& getKnownPluginList() noexcept { return knownPlugins; }

    /** Where Plectrify installs plugins on the user's behalf (the plugin
        catalogue — see CatalogueInstaller): %PROGRAMDATA%\Plectrify\plugins on
        Windows, ~/Library/Audio/Plug-Ins/VST3 on macOS.

        On Windows, under ProgramData rather than a profile folder because
        these are ordinary VST3s the user can point any other host at — a
        shared, conventional machine-wide location every account can reach,
        with no roaming of a few hundred megabytes of native binaries. Users
        may create files and folders there by default, so installing needs no
        elevation; what a given account creates it owns, so a second account on
        the same machine can add packages but not overwrite the first
        account's. On macOS the machine-wide /Library is admin-owned, so the
        per-user VST3 convention keeps installs elevation-free while other
        hosts still find the plugins. Both are deliberately outside the web
        view's file sandbox (%APPDATA%/Plectrify resp. ~/Library/Application
        Support/Plectrify), which the page can read and delete within.

        Created on demand: the scanner needs the directory to exist before it
        will search it. */
    static juce::File getManagedPluginDirectory();

    /** Whether that directory is Plectrify's alone. It is on Windows, where it
        is a folder under Plectrify's own ProgramData root that nothing else
        writes to; it is not on macOS, where it is the user's
        ~/Library/Audio/Plug-Ins/VST3, shared with every other VST3 installer.

        The distinction decides what an unaccounted-for bundle in there means —
        our own debris, or somebody else's plugin — which is the whole of
        mayReplaceManagedPlugin()'s `directoryIsExclusive`. */
    static constexpr bool managedPluginDirectoryIsExclusive =
       #if JUCE_MAC
        false;
       #else
        true;
       #endif

    /** The plugins Plectrify **ships**, beside the executable (Windows) or inside
        the app bundle (macOS).

        Not the same thing as the managed directory above, and deliberately so.
        That one holds plugins the user chose to install, in a folder they own,
        which other hosts can see and which survives uninstalling Plectrify. This
        one is part of the application: read-only, never listed by the Packages
        panel, and gone when the app is. Neural Amp Modeler lives here because
        every TONE3000 tone is a capture that loads into it — a catalogue of
        captures with nothing to play them in is not a product, so it is not
        something to ask the user to go and fetch.

        Empty in a plain Debug build unless PLECTRIFY_BUNDLED_PLUGIN_DIR points
        somewhere (see CMakeLists.txt); the dev loop otherwise finds whatever is
        already installed on the machine. */
    static juce::File getBundledPluginDirectory();

    /** Default search paths for the registered formats (e.g. the system VST3
        folders), plus getManagedPluginDirectory() and
        getBundledPluginDirectory(). */
    juce::FileSearchPath getDefaultSearchPaths() const;

    /** Scans on a background thread. `onPluginScanned` fires after every
        scanned file with `listChanged` telling whether the known list gained
        entries (false for files skipped as already known), and `onFinished`
        fires once at the end — both ON THE SCAN THREAD; callers marshal to
        the message thread themselves. Returns false (and does nothing) when
        a scan is already running. */
    bool scanAndAddPluginsAsync (const juce::FileSearchPath& paths,
                                 std::function<void (bool listChanged)> onPluginScanned,
                                 std::function<void()> onFinished);

    bool isScanning() const noexcept { return scanning.load(); }

    /** The plugin files the scanner refuses to touch. A file lands here when a
        scan was interrupted while loading it — a crashing plugin, but equally
        the app being closed or killed mid-scan — and nothing retries it on its
        own, so the user needs a way to see and clear the list. */
    juce::StringArray getBlacklistedPlugins() const;

    /** Drops `files` from the blacklist — the whole blacklist when `files` is
        empty — so the next scan loads them again, and persists the change.
        Returns how many entries were actually removed.

        Message thread only, and a no-op (returns 0) while a scan is running:
        the scan thread owns the blacklist and the cache file for its duration. */
    int unblacklistPlugins (const juce::StringArray& files);

    /** Asynchronously creates an instance. The callback receives the instance
        (moved) or nullptr plus an error string, always on the message thread. */
    void createInstanceAsync (
        const juce::PluginDescription& desc,
        double sampleRate,
        int blockSize,
        std::function<void (std::unique_ptr<juce::AudioPluginInstance>, const juce::String&)> callback);

    void saveToSettings();
    void loadFromSettings();

private:
    void run() override;
    juce::File getCacheFile() const;

    /** Drops known-list and blacklist entries whose file no longer exists on
        disk (uninstalled plugins). Returns true if anything was removed. */
    bool pruneMissingPlugins();

    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPlugins;

    juce::FileSearchPath pathsToScan;
    std::function<void (bool listChanged)> pluginScannedCallback;
    std::function<void()> finishedCallback;
    std::atomic<bool> scanning { false };
};
