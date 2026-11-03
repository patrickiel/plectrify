#pragma once

#include <JuceHeader.h>

#include <atomic>
#include <functional>

/**
    Knows which plugins exist on this machine and how to instantiate them.

    Owns the format manager — VST3, plus the VST2-era .dll/.vst/.so format when
    the build enables it (PLECTRIFY_HOST_LEGACY_PLUGINS; never named "VST" to
    the user, see AGENTS.md) — and a KnownPluginList that is
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
        hosts still find the plugins. Linux follows macOS for the same reason:
        /usr/lib/vst3 is root's, so it is the per-user ~/.vst3 every Linux host
        searches. All are deliberately outside the web view's file sandbox
        (%APPDATA%/Plectrify resp. ~/Library/Application Support/Plectrify
        resp. ~/.config/Plectrify), which the page can read and delete within.

        Created on demand: the scanner needs the directory to exist before it
        will search it. */
    static juce::File getManagedPluginDirectory();

    /** Whether that directory is Plectrify's alone. It is on Windows, where it
        is a folder under Plectrify's own ProgramData root that nothing else
        writes to; it is not on macOS or Linux, where it is the user's
        ~/Library/Audio/Plug-Ins/VST3 resp. ~/.vst3, shared with every other
        VST3 installer.

        The distinction decides what an unaccounted-for bundle in there means —
        our own debris, or somebody else's plugin — which is the whole of
        mayReplaceManagedPlugin()'s `directoryIsExclusive`. */
    static constexpr bool managedPluginDirectoryIsExclusive =
       #if JUCE_MAC || JUCE_LINUX
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
        folders), plus getManagedPluginDirectory(), getBundledPluginDirectory()
        and every folder the user added (getUserFolders()). */
    juce::FileSearchPath getDefaultSearchPaths() const;

    /** Folders the user added to the search path, in the order they were added.

        The formats' default locations cover what installers put in the
        conventional places; a lot of what people actually own lives wherever
        they unpacked it — a `D:\Plugins`, a `Common Files\VST2` nobody looks
        in — and the legacy single-file format has no convention worth the
        name. So the user names the folder and it is searched like the defaults
        from then on. Machine state, like known_plugins.xml: persisted in
        `plugin_folders.json` beside it under the data root, left out of
        backups, kept by a reset (see AppReset.h). Message thread only. */
    juce::StringArray getUserFolders() const;

    /** Adds a folder; false (and nothing happens) when it is not a directory
        or already listed. Persists. The caller scans it — this class never
        starts a scan on its own. */
    bool addUserFolder (const juce::File& folder);

    /** Drops a folder and forgets the known plugins and blacklist entries
        under it (pruneMissingPlugins cannot: the files are still there, they
        are just no longer searched). Persists both files. False when the
        folder was not listed — or while a scan runs, since the scan thread
        owns the known list for its duration (the same rule as
        unblacklistPlugins); the caller may try again when it ends. */
    bool removeUserFolder (const juce::File& folder);

    static juce::File getUserFoldersFile();

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

    /** A plugin file the scan found and could not load, with the one reason we
        can state with confidence (PluginBinary.h): "bits32" — a 32-bit binary
        in this 64-bit process — or "wrongArch" — a 64-bit binary for another
        processor (an Intel-only plugin on Apple Silicon). JUCE's scanner is
        silent about these: no type, no error, no blacklist entry, so without
        this the plugin simply is not in the drawer and the user has nothing
        to go on. A file the scan yields nothing for and we cannot explain (a
        helper library beside a plugin, a broken plugin) is not listed at all
        rather than listed with a guess. */
    struct UnloadablePlugin
    {
        juce::String path;
        juce::String reason;
    };

    /** Any thread (a locked copy). Every scan rebuilds the entries under the
        folders it covered — a file fixed or replaced drops out, one added
        shows up — and the list is persisted in the cache beside the blacklist
        so it survives a launch that runs no scan. */
    juce::Array<UnloadablePlugin> getUnloadablePlugins() const;

    /** A live instance's description in the form a later createInstanceAsync
        accepts — what to persist, never inst.getPluginDescription() directly.
        On Linux JUCE fills a hosted VST3's description from the module it
        loaded, `Foo.vst3/Contents/x86_64-linux/Foo.so`, while its VST3 format
        only ever accepts the `.vst3` bundle: persisted raw, every module
        restores as missing. */
    static juce::PluginDescription describeInstance (const juce::AudioPluginInstance& instance);

    /** Asynchronously creates an instance. The callback receives the instance
        (moved) or nullptr plus an error string, always on the message thread.

        A description whose file no longer exists is re-resolved against the
        scan cache by plugin identity before instantiation: a saved rig bakes
        the absolute path it was loaded from, which may belong to another
        build's copy of the same plugin (the bundled plugin's path is per-build
        by construction). A Linux module path inside a bundle is mapped back to
        the bundle first (see describeInstance), so documents written before
        that existed still load. */
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
    void loadUserFolders() const;   // re-reads plugin_folders.json into userFolders
    void saveUserFolders() const;

    /** Drops known-list and blacklist entries whose file no longer exists on
        disk (uninstalled plugins). Returns true if anything was removed. */
    bool pruneMissingPlugins();

    /** Scan thread, after every format has run: takes the very files each
        format's scanner was given (`scannedFiles`, one list per format in
        getFormats() order) and records the ones that produced nothing and
        whose binary says why. Replaces the entries under pathsToScan. */
    void recordUnloadablePlugins (const std::vector<juce::StringArray>& scannedFiles);

    /** Where `format` belongs: its own default locations, every user folder,
        and — for VST3, the only format either can hold — the managed and
        bundled directories. Message thread (reads userFolders). */
    juce::FileSearchPath ownLocations (juce::AudioPluginFormat& format) const;

    /** The part of `paths` that `format` should walk: each path inside one of
        its ownLocations(), plus each of those locations inside a path, with
        nested entries collapsed so no file is listed twice. Without this the
        older format walked every VST3 folder and LoadLibrary'd any loose
        helper .dll it found there. Message thread. */
    juce::FileSearchPath pathsForFormat (juce::AudioPluginFormat& format,
                                         const juce::FileSearchPath& paths) const;

    /** Whether `path` lies in a location some format still searches — for a
        known type, the format named (`formatName`); empty means any. */
    bool isStillSearched (const juce::String& path, const juce::String& formatName) const;

    /** The files `format` would scan under `paths`, minus — for any format but
        VST3 — binaries inside another format's bundle. Scan thread. */
    juce::StringArray filesToScan (juce::AudioPluginFormat& format,
                                   const juce::FileSearchPath& paths) const;

    /** Drops older-format types and blacklist entries inside a bundle, which
        scans before filesToScan's rule recorded. Scan thread. */
    void pruneFilesInsideBundles();

    /** Whether a parent directory of `path` is a .vst3 or .component bundle. */
    static bool isInsideAnotherFormatsBundle (const juce::String& path);

    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPlugins;

    juce::FileSearchPath pathsToScan;
    std::vector<juce::FileSearchPath> formatPathsToScan; // per format, getFormats() order; set before the thread starts
    mutable juce::StringArray userFolders;  // absolute paths, re-read from disk on use; message thread only
    juce::Array<UnloadablePlugin> unloadable;   // guarded by unloadableLock
    mutable juce::CriticalSection unloadableLock;
    std::function<void (bool listChanged)> pluginScannedCallback;
    std::function<void()> finishedCallback;
    std::atomic<bool> scanning { false };
};
