#pragma once

#include <JuceHeader.h>

#include "Catalogue.h"

#include <atomic>
#include <functional>
#include <map>
#include <vector>

/**
    Downloads, verifies and installs catalogue plugins into
    PluginManager::getManagedPluginDirectory().

    The catalogue is fetched from the server (Debug builds read
    packaging/catalogue.json from the source tree instead), so a plugin's
    new release reaches users without a Plectrify release — the panel just offers
    an update on that row.

    SECURITY. Two gates, and neither is optional:
      * the manifest carries a detached signature verified against a key
        compiled into this binary — unverified bytes are never parsed;
      * every asset is checked against the manifest's SHA-256 before a single
        byte reaches the plugin directory.
    What lands in that directory gets loaded into this process, so a failure at
    either gate discards the download rather than degrading to "install it
    anyway".

    Threading: all public methods are message-thread only. Fetching, hashing
    and unzipping run on a single pool thread (jobs run in submission order);
    callbacks are marshalled back to the message thread. Callers guard their
    own lifetime inside a callback (e.g. Component::SafePointer). The
    destructor blocks until in-flight jobs finish, so a job never outlives the
    installer.
*/
class CatalogueInstaller
{
public:
    /** How far along one package is. Ordered as the install proceeds, so the
        UI can render a row from the last stage it saw. */
    enum class Stage
    {
        queued,
        downloading,
        verifying,
        extracting,
        installing,
        installed,
        skipped,     // already present at the manifest's version
        failed
    };

    /** A package definition joined with what is actually on disk. Plugins and
        content packages share this row: they differ in `package.kind`, which the
        installer reads and the panel does not. */
    struct Item
    {
        CataloguePackage package;
        bool installed = false;
        juce::String installedVersion;   // empty when not installed
        bool updateAvailable = false;    // installed at a different version
        bool unlisted = false;           // installed but no longer in the catalogue
        /** Whether installing this row could succeed on this platform: it has a
            payload here, and so does every package in its dependency chain —
            because installing it installs that chain too. False greys the row
            and disables every install action on it. Always false for an
            `unlisted` row, which has no catalogue entry left to offer. */
        bool available = false;
    };

    /** A bundle joined with how much of it is installed. Bundles hold only package
        IDs, so everything here is derived from the package rows rather than
        stored twice. */
    struct BundleItem
    {
        CatalogueBundle bundle;
        juce::StringArray missingPackageIds;   // not installed at all
        juce::StringArray outdatedPackageIds;  // installed at a different version
        /** The bundle version recorded when it was last fully installed, or empty.
            Kept separately from the packages' own versions: a bundle changes when
            its membership changes, which is independent of any package update. */
        juce::String installedVersion;

        bool isFullyInstalled() const { return missingPackageIds.isEmpty(); }
        /** True when the published bundle differs from the edition installed —
            either it gained packages, or its version was bumped. */
        bool updateAvailable() const
        {
            return installedVersion.isNotEmpty()
                && (installedVersion != bundle.version || ! missingPackageIds.isEmpty());
        }
    };

    struct Progress
    {
        juce::String id;
        juce::String name;
        Stage stage = Stage::queued;
        int index = 0;                   // 1-based position in this run
        int count = 0;
        juce::int64 received = 0;
        juce::int64 total = 0;
        juce::String error;              // set when stage == failed
    };

    struct Result
    {
        juce::StringArray installed, skipped, removed;
        std::vector<std::pair<juce::String, juce::String>> failed; // id, error
        bool cancelled = false;
    };

    CatalogueInstaller();
    ~CatalogueInstaller();

    /** Resolves the catalogue: the source-tree file in Debug, otherwise a
        fetch with a fall back to the last verified copy. Safe to call
        repeatedly; the panel calls it on open so a user who just got online
        doesn't have to restart. */
    void refreshCatalogueAsync (std::function<void()> onDone);

    /** The catalogue joined with disk state — every package, plugin and
        content alike, in the catalogue's own order. Empty until the first
        refresh completes (or when nothing could be verified). */
    std::vector<Item> getItems() const;

    /** File or bundle name directly inside the managed plugin directory ->
        the package id whose install marker recorded it, for joining a scanned
        plugin back to the catalogue package that installed it. Bundle records
        ("bundle-") and content records ("content-") are skipped — neither
        puts anything in the load path. Message thread; re-reads the marker
        directory on each call, which holds a handful of small files. */
    static std::map<juce::String, juce::String> installedPluginFileOwners();

    /** The machine-wide folder whose direct children are the content
        directories: %PROGRAMDATA%/Plectrify on Windows, /Users/Shared/Plectrify on
        macOS. Both are fixed paths writable without elevation — a patch's
        plugin state bakes the absolute path of each asset it loads, so this
        root must be identical on every machine. On Windows it is the plugin
        directory's parent; on macOS the plugin directory is per-user and the
        two roots are unrelated. */
    static juce::File contentRootDirectory();

    /** Where a content package unpacks to:
        contentRootDirectory()/<installDir>, e.g. …/Plectrify/irs. Shared,
        findable from other hosts, non-roaming, and outside the web view's
        file sandbox. */
    static juce::File contentDirectory (const juce::String& installDir);

    /** Create `directory` and every level of it up to the content root with
        the semantics that root needs: on macOS, mode 1777 like /Users/Shared
        itself, so any account may add something of its own and the sticky bit
        keeps each able to remove only what it owns. Created through the stock
        umask it would be 0755 and owned by whichever account installed first,
        and no second account could add a package — or a TONE3000 download —
        beside it without elevation. Windows' ProgramData carries an equivalent
        ACL already, so this is a no-op there.

        Public because the TONE3000 downloads folder is a second writer under
        the same root and must establish exactly the same semantics; two copies
        of this rule would be one too many. */
    static void createSharedContentDirectory (const juce::File& directory);

    /** The bundles, joined with how much of each is on disk. */
    std::vector<BundleItem> getBundles() const;

    /** Records that `bundleId` is now installed at its catalogue version. Called
        after an install run that covered the whole bundle, so the panel can say
        which edition the user has. */
    void noteBundleInstalled (const juce::String& bundleId);

    CatalogueSource getCatalogueSource() const noexcept { return catalogueSource; }

    /** Licence disclosure that came with the catalogue. */
    CatalogueNotices getNotices() const;

    /** Where to get the content the plugins need (amp captures, IRs). Plectrify
        bundles none of it, so these links are the answer to "installed, now
        what?". */
    std::vector<CatalogueLink> getLinks() const;

    /** Why the catalogue is empty or stale, for the panel to show. Empty when
        all is well. */
    juce::String getCatalogueError() const;

    /** Installs (or updates) the named packages, in order. Ids not in the
        catalogue are ignored. Returns false if a run is already in flight —
        the caller should surface "busy" rather than queue a second run. */
    bool installAsync (const juce::StringArray& ids,
                       std::function<void (Progress)> onProgress,
                       std::function<void (Result)> onFinished);

    /** Removes the named packages: deletes the files the install marker
        recorded, then the marker itself. Only plain child names are accepted,
        and the recorded root must be the managed plugin directory or a direct
        content directory inside Plectrify's machine-wide content folder
        (ProgramData on Windows, /Users/Shared on macOS). A plugin whose
        recorded fingerprint no longer matches what is on disk was replaced by
        something Plectrify did not install, so it is disowned rather than
        deleted — the marker goes and the file stays.

        On Windows, a plugin currently loaded in the rack holds its DLL open
        and the OS refuses the delete; that package reports `locked` and stays
        installed rather than being left half-removed. (POSIX permits the
        delete, so the condition does not arise on macOS.) Refused (returns
        false) while an install is running, so the two never race over the
        same directory. */
    bool uninstallAsync (const juce::StringArray& ids,
                         std::function<void (Result)> onFinished);

    /** Asks the running job to stop at the next checkpoint. The current
        package's partial download is discarded; packages already installed
        stay installed. */
    void cancel() noexcept { cancelRequested = true; }

    bool isRunning() const noexcept { return running.load(); }

    /** Directory the packages install into — PluginManager's managed dir. */
    static juce::File installDirectory();

    /** Remove a package that used to be offered and is now part of the
        application, if this machine installed it back when it was offered.

        Neural Amp Modeler is the only one, and the reason is duplicates: it now
        ships inside Plectrify and is scanned from there, so a copy left in the
        managed directory from an older version would appear in the plugin list
        twice — same name, two paths, and no way for the user to tell which a
        patch means. The ordinary uninstall path does the work, fingerprint
        check and all, so a bundle the user replaced with a build of their own
        is disowned rather than deleted.

        A no-op with nothing to remove, which is every machine that never
        installed it and every launch after the first. */
    bool retirePackageAsync (const juce::String& id, std::function<void (Result)> onFinished);

    /** Did this machine install `id` from the catalogue? */
    static bool isInstalledFromCatalogue (const juce::String& id);

private:
    struct InstallOutcome
    {
        Stage stage = Stage::failed;
        juce::String error;
    };

    /** One thing to download and unpack. Plugins and content packages share the
        whole download-verify-extract path and differ only at the end — a
        plugin's VST3 bundles are moved into the scan path, content is unpacked
        flat into its own folder — so they are normalised to this rather than
        duplicating that path twice. */
    struct Installable
    {
        juce::String id;          // catalogue id, for the caller
        juce::String markerId;    // install-marker key ("content-" prefixed for content)
        juce::String dependsOn;   // catalogue id that must have installed successfully first
        juce::String name, version, sha256, assetUrl;
        juce::StringArray include;
        juce::int64 downloadBytes = 0;
        juce::File targetDir;
        /** false when the catalogue offers no payload for this build's
            platform. The row is greyed in the panel, so reaching the installer
            anyway (a stale page, a dependency chain) reports a plain failure
            instead of downloading another platform's binary. */
        bool availableHere = true;
        /** true: hunt for .vst3 bundles and move them. false: unpack the
            matching files flat. Nothing in a content package is ever loaded as
            code, which is why it does not go near the scan path. */
        bool pluginSemantics = true;
        /** Content only: move each top-level entry across whole instead of
            flattening, so a patch stays one folder with its assets. See
            `CataloguePackage::preserveStructure`. */
        bool preserveStructure = false;
    };

    void loadCatalogueOnPoolThread();
    InstallOutcome installOne (const Installable&, const std::function<void (Progress)>&,
                               Progress&);

    /** The install-marker key for a package: its id, or "content-<id>" for a
        content package. One definition, because every path that records,
        reads or removes an install has to agree on it. */
    static juce::String markerIdFor (const CataloguePackage&);

    /** Every plugin install marker's parsed record, keyed by marker id. Bundle
        and content records are skipped — neither puts anything in the load
        path. Re-read on each call; there are a handful of small files. */
    static std::map<juce::String, juce::var> pluginInstallRecords();

    /** File or bundle name in the managed plugin directory -> the fingerprint
        recorded when Plectrify installed it, empty for a record written before
        fingerprints were. A name absent from this map is one no install of
        ours accounts for, and so is not Plectrify's to replace — which is the
        distinction that matters on macOS, where the managed directory is the
        user's own VST3 folder rather than one Plectrify owns. */
    static std::map<juce::String, juce::String> installedPluginFileClaims();

    /** What a marker on disk records. `pending` is a claim on the names an
        install is about to write, put down *before* the first file moves; it
        carries no version and no fingerprints, so the row still reads as not
        installed and the next attempt neither skips it nor is refused by the
        replace guard.

        It exists because the file and the record of it cannot be written at the
        same instant, and the window between them is real: quitting Plectrify
        (or the dev loop killing it to relink) after a bundle has moved and
        before its marker lands used to leave a plugin in the load path that
        nothing accounted for — which the guard then refused to replace on every
        subsequent attempt, with no way out from inside the app. Claiming first
        makes the leftover recoverable instead: the next install owns the name,
        and Remove can clear it. */
    enum class MarkerState { pending, complete };

    static juce::File markerFile (const juce::String& id);
    static juce::String readInstalledVersion (const juce::String& id);
    static void writeMarker (const Installable&, const juce::StringArray& files, MarkerState);
    static juce::File bundleMarkerFile (const juce::String& bundleId);

    juce::ThreadPool pool { 1 };

    mutable juce::CriticalSection catalogueLock;
    Catalogue catalogue;
    CatalogueNotices notices;
    std::vector<CatalogueLink> links;
    juce::String catalogueError;
    std::atomic<CatalogueSource> catalogueSource { CatalogueSource::none };

    std::atomic<bool> running { false };
    std::atomic<bool> cancelRequested { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CatalogueInstaller)
};
