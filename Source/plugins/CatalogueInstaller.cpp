#include "CatalogueInstaller.h"

#include "PluginManager.h"

#if JUCE_MAC
 #include <sys/stat.h>
#endif

namespace
{
/** Where the published catalogue lives. Release builds fetch this; Debug
    builds read the source tree instead (PLECTRIFY_CATALOGUE_FILE).

    Set at configure time (PLECTRIFY_CATALOGUE_URL in CMakeLists.txt) rather
    than hard-coded, so pointing a build elsewhere is a build setting, not a
    source edit — and so a fork can point at its own bucket without patching
    this file. The fallback below only applies to a build that did not set it,
    and mirrors what CMakeLists.txt configures.

    The `/v1/` segment is the *catalogue schema* version, not the app's. Bump it
    only for a change old builds cannot read; ordinary plugin updates are a new
    revision of the same manifest at the same URL, which is the whole point of
    hosting it. */
#if ! defined(PLECTRIFY_CATALOGUE_URL)
    #define PLECTRIFY_CATALOGUE_URL "https://cdn.plectrify.com/plugins/v1"
#endif

const juce::String manifestUrl { juce::String (PLECTRIFY_CATALOGUE_URL) + "/catalogue.json" };
const juce::String signatureUrl { manifestUrl + ".sig" };

/** One attempt, short timeout. A launch-time fetch that retries in a loop
    turns a flaky connection into a stalled start-up; the panel offers an
    explicit refresh instead. */
constexpr int fetchTimeoutMs = 10000;

juce::String fetchText (const juce::String& url, juce::String& errorOut)
{
    const auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                             .withConnectionTimeoutMs (fetchTimeoutMs);

    auto stream = juce::URL (url).createInputStream (options);

    if (stream == nullptr)
    {
        errorOut = "couldn't reach " + url;
        return {};
    }

    return stream->readEntireStreamAsString();
}

juce::File cacheFile()
{
    return CatalogueInstaller::installDirectory().getChildFile ("manifest.cache.json");
}

juce::File signatureCacheFile()
{
    return CatalogueInstaller::installDirectory().getChildFile ("manifest.cache.json.sig");
}

/** Atomic write: a torn manifest cache would be indistinguishable from a
    tampered one, and would be rejected on every subsequent launch. */
bool writeAtomically (const juce::File& target, const juce::String& contents)
{
    const auto temp = target.getSiblingFile (target.getFileName() + ".tmp");
    temp.deleteFile();

    if (! temp.replaceWithText (contents))
        return false;

    return temp.moveFileTo (target);
}

/** A plugin the user is auditioning holds its DLL open, and Windows refuses
    the replace. That is a "close and reopen Plectrify" situation, not a broken
    download — worth saying so precisely. Windows-only by nature: POSIX lets
    an open file be replaced (the running session keeps its mapped code, new
    loads see the new file), so there is no such condition to detect on macOS. */
bool looksLikeSharingViolation (const juce::File& target)
{
   #if JUCE_WINDOWS
    return target.existsAsFile() && ! target.hasWriteAccess();
   #else
    juce::ignoreUnused (target);
    return false;
   #endif
}

/** Whether this platform is offered everything installing `package` would
    fetch: its own payload, and the payload of every package in the dependency
    chain the installer expands it into.

    The chain has to count. A patch offered here whose plugin is not would
    advertise as installable, queue that plugin first and fail on a package this
    platform was never offered — so the honest answer is that the row cannot be
    installed here, which greys it exactly as a missing payload of its own does.
    `validate` refuses to publish such a catalogue at all; this is the app
    declining to advertise one that reached it anyway.

    Cycle-safe on the same terms as resolveInstallOrder, and it stops at a
    dependency this catalogue does not define — parsing has already rejected
    one of those, so there is nothing further to say about it here. */
bool isAvailableHere (const std::vector<CataloguePackage>& packages,
                      const CataloguePackage& package)
{
    juce::StringArray visited;

    for (const auto* p = &package; p != nullptr;)
    {
        if (! p->assetFor (catalogueRuntimePlatform).has_value())
            return false;

        visited.add (p->id);

        if (p->dependsOn.isEmpty() || visited.contains (p->dependsOn))
            break;

        const auto found = std::find_if (
            packages.begin(), packages.end(),
            [p] (const CataloguePackage& c) { return c.id == p->dependsOn; });

        p = found != packages.end() ? &*found : nullptr;
    }

    return true;
}

} // namespace

/** Create a content package's directory, and on macOS give it — and every level
    of the shared content root above it — the mode /Users/Shared itself carries:
    writable by every account, sticky so each can still only remove what it owns.

    Without this the promise the shared root was chosen for does not hold. JUCE
    creates a directory through the process umask, 0755 on a stock mac, so the
    first account to install anything would own /Users/Shared/Plectrify and the
    installDir beneath it, and no second account could add a package there — or
    another patch beside an existing one — without elevation. ProgramData's
    inherited ACL already gives the Windows build exactly these rights, which is
    why that branch needs nothing.

    Every level, because a 0755 root blocks a writable child just as thoroughly.
    And only ever widening: chmod on a directory another account created fails,
    which is the right answer — that account either already made it shared or
    deliberately did not, and this one does not get to overrule it. Files stay
    at the umask that wrote them, so a package still belongs to the account that
    installed it, exactly as on Windows. */
void CatalogueInstaller::createSharedContentDirectory (const juce::File& directory)
{
    directory.createDirectory();

   #if JUCE_MAC
    const auto root = CatalogueInstaller::contentRootDirectory();

    for (auto level = directory; level == root || level.isAChildOf (root);
         level = level.getParentDirectory())
    {
        ::chmod (level.getFullPathName().toRawUTF8(), S_ISVTX | 0777);

        if (level == root)
            break;
    }
   #endif
}

CatalogueInstaller::CatalogueInstaller() = default;

CatalogueInstaller::~CatalogueInstaller()
{
    cancelRequested = true;
    pool.removeAllJobs (true, 10000);
}

juce::File CatalogueInstaller::installDirectory()
{
    return PluginManager::getManagedPluginDirectory();
}

bool CatalogueInstaller::isInstalledFromCatalogue (const juce::String& id)
{
    return markerFile (id).existsAsFile();
}

bool CatalogueInstaller::retirePackageAsync (const juce::String& id,
                                             std::function<void (Result)> onFinished)
{
    if (! isInstalledFromCatalogue (id))
        return false;

    return uninstallAsync ({ id }, std::move (onFinished));
}

juce::File CatalogueInstaller::markerFile (const juce::String& id)
{
    return installDirectory().getChildFile (".plectrify-installed").getChildFile (id + ".json");
}

juce::String CatalogueInstaller::readInstalledVersion (const juce::String& id)
{
    const auto marker = markerFile (id);
    if (! marker.existsAsFile())
        return {};

    const auto parsed = juce::JSON::parse (marker.loadFileAsString());
    return parsed["version"].toString();
}

void CatalogueInstaller::writeMarker (const Installable& plugin,
                                        const juce::StringArray& files,
                                        MarkerState state)
{
    const bool complete = state == MarkerState::complete;

    auto* record = new juce::DynamicObject();
    record->setProperty ("id", plugin.id);

    // A pending claim records no version: getItems() reads an empty one as not
    // installed, and installOne() would otherwise skip the package it is in the
    // middle of installing.
    record->setProperty ("version", complete ? plugin.version : juce::String());
    record->setProperty ("sha256", plugin.sha256);
    record->setProperty ("installedAt", juce::Time::getCurrentTime().toISO8601 (true));

    juce::Array<juce::var> fileList;
    for (const auto& f : files)
        fileList.add (f);
    record->setProperty ("files", fileList);

    // What each of those names *was* when we wrote it, positionally aligned
    // with `files` — a name is not a legal juce::Identifier, so this cannot be
    // an object keyed by one. Install and uninstall both compare against it
    // before touching anything, which is what makes "delete only what we
    // wrote" true rather than merely intended.
    //
    // Plugins only. Their directory is shared with every other VST3 installer
    // on macOS, which is the whole reason for recording this. A content
    // package owns its directory under Plectrify's own content root, and on
    // macOS that root is shared between accounts while these markers are
    // per-user — so fingerprinting content would make a second account's
    // install refuse the files the first account legitimately put there.
    //
    // A pending claim records none either: nothing is at those paths yet, and
    // an empty fingerprint is exactly the "Plectrify wrote this, take it at its
    // word" case the replace guard already understands.
    if (plugin.pluginSemantics && complete)
    {
        juce::Array<juce::var> fingerprints;
        for (const auto& f : files)
            fingerprints.add (installedFileFingerprint (plugin.targetDir.getChildFile (f)));
        record->setProperty ("fingerprints", fingerprints);
    }

    // Content records also carry where they landed, so uninstall can find the
    // files without re-deriving the folder from a catalogue that may have moved
    // on.
    record->setProperty ("dir", plugin.targetDir.getFullPathName());

    const auto marker = markerFile (plugin.markerId);
    marker.getParentDirectory().createDirectory();
    marker.replaceWithText (juce::JSON::toString (juce::var (record)));
}

std::map<juce::String, juce::var> CatalogueInstaller::pluginInstallRecords()
{
    std::map<juce::String, juce::var> records;

    const auto markerDir = installDirectory().getChildFile (".plectrify-installed");
    for (const auto& marker : markerDir.findChildFiles (juce::File::findFiles, false, "*.json"))
    {
        const auto markerId = marker.getFileNameWithoutExtension();

        // Only plugin records put anything in the load path: a bundle record
        // describes a bundle, and a content record's files land in a data
        // folder the scanner never reads. For plugins the marker id is the
        // package id itself (see markerIdFor).
        if (markerId.startsWith ("bundle-") || markerId.startsWith ("content-"))
            continue;

        records[markerId] = juce::JSON::parse (marker.loadFileAsString());
    }

    return records;
}

std::map<juce::String, juce::String> CatalogueInstaller::installedPluginFileOwners()
{
    std::map<juce::String, juce::String> owners;

    for (const auto& record : pluginInstallRecords())
        if (const auto* files = record.second["files"].getArray())
            for (const auto& file : *files)
                owners[file.toString()] = record.first;

    return owners;
}

std::map<juce::String, juce::String> CatalogueInstaller::installedPluginFileClaims()
{
    std::map<juce::String, juce::String> claims;

    for (const auto& record : pluginInstallRecords())
    {
        const auto* files = record.second["files"].getArray();

        if (files == nullptr)
            continue;

        const auto* fingerprints = record.second["fingerprints"].getArray();

        for (int i = 0; i < files->size(); ++i)
            claims[(*files)[i].toString()]
                = fingerprints != nullptr && i < fingerprints->size()
                      ? (*fingerprints)[i].toString()
                      : juce::String();
    }

    return claims;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

void CatalogueInstaller::refreshCatalogueAsync (std::function<void()> onDone)
{
    pool.addJob ([this, onDone = std::move (onDone)]
    {
        loadCatalogueOnPoolThread();

        if (onDone)
            juce::MessageManager::callAsync (onDone);
    });
}

void CatalogueInstaller::loadCatalogueOnPoolThread()
{
    const auto adopt = [this] (Catalogue parsed,
                               const juce::String& sourceText,
                               CatalogueSource source,
                               const juce::String& error)
    {
        const juce::ScopedLock lock (catalogueLock);
        catalogue = std::move (parsed);
        notices = parseCatalogueNotices (sourceText);
        links = parseCatalogueLinks (sourceText);
        catalogueError = error;
        catalogueSource = source;
    };

#if defined(PLECTRIFY_CATALOGUE_FILE)
    // Debug only. This path is UNSIGNED, which is exactly why the macro is a
    // Debug-only compile definition and not a runtime switch: a Release build
    // has no code path to a parsed catalogue that skips verification.
    {
        const juce::File local { PLECTRIFY_CATALOGUE_FILE };
        juce::String parseError;
        const auto text = local.loadFileAsString();
        auto parsed = parseCatalogueManifest (text, parseError);

        adopt (std::move (parsed), text, CatalogueSource::devLocal,
               parseError.isEmpty() ? juce::String() : "local manifest: " + parseError);
        return;
    }
#else
    // Establish the highest revision this process has already accepted before
    // considering the network response. The on-disk copy is untrusted until it
    // independently passes the signature and parser gates below.
    juce::int64 currentRevision = 0;
    {
        const juce::ScopedLock lock (catalogueLock);
        currentRevision = catalogue.revision;
    }

    const auto cached = cacheFile().loadFileAsString();
    const auto cachedSignature = signatureCacheFile().loadFileAsString().trim();
    Catalogue cachedCatalogue;
    bool cachedIsValid = false;

    if (cached.isNotEmpty())
    {
        const auto utf8 = cached.toRawUTF8();
        const auto numBytes = static_cast<size_t> (juce::CharPointer_UTF8 (utf8).sizeInBytes() - 1);

        if (verifyManifestSignature (utf8, numBytes, cachedSignature, catalogueSigningKey()))
        {
            juce::String parseError;
            cachedCatalogue = parseCatalogueManifest (cached, parseError);
            cachedIsValid = parseError.isEmpty();
        }
    }

    const auto acceptedRevision = juce::jmax (
        currentRevision, cachedIsValid ? cachedCatalogue.revision : juce::int64 { 0 });

    juce::String fetchError;
    const auto manifest = fetchText (manifestUrl, fetchError);
    const auto signature = fetchError.isEmpty() ? fetchText (signatureUrl, fetchError)
                                                : juce::String();

    if (fetchError.isEmpty() && manifest.isNotEmpty())
    {
        const auto utf8 = manifest.toRawUTF8();
        const auto numBytes = static_cast<size_t> (juce::CharPointer_UTF8 (utf8).sizeInBytes() - 1);

        if (verifyManifestSignature (utf8, numBytes, signature.trim(), catalogueSigningKey()))
        {
            juce::String parseError;
            auto parsed = parseCatalogueManifest (manifest, parseError);

            if (parseError.isEmpty())
            {
                if (isCatalogueRevisionRollback (parsed.revision, acceptedRevision))
                {
                    fetchError = "the signed plugin catalogue revision "
                               + juce::String (parsed.revision)
                               + " is older than accepted revision "
                               + juce::String (acceptedRevision);
                }
                else
                {
                    // Only cache what verified, parsed and did not roll back,
                    // so the fallback can never be worse than a copy already
                    // accepted by this process or left on disk.
                    installDirectory().createDirectory();
                    writeAtomically (cacheFile(), manifest);
                    writeAtomically (signatureCacheFile(), signature.trim());

                    adopt (std::move (parsed), manifest, CatalogueSource::remote, {});
                    return;
                }
            }
            else
            {
                fetchError = parseError;
            }
        }
        else
        {
            fetchError = "the plugin catalogue's signature didn't verify";
        }
    }

    // A refresh must not replace an in-memory catalogue with an older cache
    // either. Keep the current copy when it is at least as new, but surface why
    // the refresh could not advance it.
    if (currentRevision > 0
        && (! cachedIsValid || currentRevision >= cachedCatalogue.revision))
    {
        const juce::ScopedLock lock (catalogueLock);
        catalogueError = fetchError;
        return;
    }

    if (cachedIsValid)
    {
        adopt (std::move (cachedCatalogue), cached, CatalogueSource::cache, fetchError);
        return;
    }

    adopt ({}, {}, CatalogueSource::none,
           fetchError.isEmpty() ? juce::String ("no plugin catalogue available") : fetchError);
#endif
}

CatalogueNotices CatalogueInstaller::getNotices() const
{
    const juce::ScopedLock lock (catalogueLock);
    return notices;
}

std::vector<CatalogueLink> CatalogueInstaller::getLinks() const
{
    const juce::ScopedLock lock (catalogueLock);
    return links;
}

juce::String CatalogueInstaller::getCatalogueError() const
{
    const juce::ScopedLock lock (catalogueLock);
    return catalogueError;
}

juce::String CatalogueInstaller::markerIdFor (const CataloguePackage& package)
{
    // Content markers are prefixed so a content id can never collide with a
    // plugin id in the shared marker folder — the two were separate namespaces
    // in the manifest before they were one list, and old installs on disk still
    // carry the prefix. Defined once here so getItems, the bundle rollup, the
    // install path and the skip-if-current check cannot disagree about which
    // file records a given package.
    return package.isContent() ? "content-" + package.id : package.id;
}

std::vector<CatalogueInstaller::Item> CatalogueInstaller::getItems() const
{
    std::vector<CataloguePackage> packages;
    {
        const juce::ScopedLock lock (catalogueLock);
        packages = catalogue.packages;
    }

    std::vector<Item> items;
    items.reserve (packages.size());

    juce::StringArray listedMarkerIds;

    for (const auto& package : packages)
    {
        Item item;
        item.package = package;
        item.installedVersion = readInstalledVersion (markerIdFor (package));
        item.installed = item.installedVersion.isNotEmpty();
        item.available = isAvailableHere (packages, package);

        // Inequality, not ordering: these projects don't share a version
        // scheme, and a deliberate downgrade after a bad release must show up
        // as an available change too.
        item.updateAvailable = item.installed && item.installedVersion != package.version;

        listedMarkerIds.add (markerIdFor (package));
        items.push_back (std::move (item));
    }

    // A package dropped from the catalogue stays installed and working — it
    // just stops being offered. Silently vanishing from the panel would leave
    // the user with a plugin they can't account for.
    const auto markerDir = installDirectory().getChildFile (".plectrify-installed");
    for (const auto& marker : markerDir.findChildFiles (juce::File::findFiles, false, "*.json"))
    {
        const auto markerId = marker.getFileNameWithoutExtension();

        // Bundle records share this directory but describe a bundle, not a
        // package; without this each would render as a phantom installed plugin
        // named "bundle-starter".
        if (markerId.startsWith ("bundle-"))
            continue;

        if (listedMarkerIds.contains (markerId))
            continue;

        // Recover the kind from the marker's own name: it is all that is left
        // once the catalogue entry is gone, and getting it wrong here would
        // offer to remove a data folder as though it were a plugin.
        const auto isContent = markerId.startsWith ("content-");

        Item item;
        item.package.kind = isContent ? PackageKind::content : PackageKind::plugin;
        item.package.id = isContent ? markerId.substring (juce::String ("content-").length())
                                    : markerId;
        item.package.name = item.package.id;
        item.installed = true;
        item.installedVersion = readInstalledVersion (markerId);
        item.unlisted = true;
        items.push_back (std::move (item));
    }

    return items;
}

juce::File CatalogueInstaller::contentRootDirectory()
{
   #if JUCE_MAC
    // Content must land at an absolute path identical on every machine: a
    // patch's plugin state bakes the full path of each asset it loads, so a
    // per-user root would produce packs that only work on their author's
    // account. /Users/Shared is the one stock macOS location that is both
    // fixed and user-writable without elevation — the same semantics
    // ProgramData gives the Windows build (each account owns what it
    // creates). The plugin dir is per-user on macOS, so this cannot derive
    // from it the way the Windows branch does.
    return juce::File ("/Users/Shared/Plectrify");
   #else
    return installDirectory().getParentDirectory();
   #endif
}

juce::File CatalogueInstaller::contentDirectory (const juce::String& installDir)
{
    // isSafeInstalledFileName() has already rejected anything with a separator,
    // so this cannot escape the Plectrify folder.
    return contentRootDirectory().getChildFile (installDir);
}

juce::File CatalogueInstaller::bundleMarkerFile (const juce::String& bundleId)
{
    // Prefixed so a bundle id can never collide with a plugin id in the same
    // directory — they are separate namespaces in the manifest.
    return installDirectory().getChildFile (".plectrify-installed")
                             .getChildFile ("bundle-" + bundleId + ".json");
}

void CatalogueInstaller::noteBundleInstalled (const juce::String& bundleId)
{
    juce::String version;
    {
        const juce::ScopedLock lock (catalogueLock);
        for (const auto& bundle : catalogue.bundles)
            if (bundle.id == bundleId)
                version = bundle.version;
    }

    if (version.isEmpty())
        return;

    auto* record = new juce::DynamicObject();
    record->setProperty ("id", bundleId);
    record->setProperty ("version", version);
    record->setProperty ("installedAt", juce::Time::getCurrentTime().toISO8601 (true));

    const auto marker = bundleMarkerFile (bundleId);
    marker.getParentDirectory().createDirectory();
    marker.replaceWithText (juce::JSON::toString (juce::var (record)));
}

std::vector<CatalogueInstaller::BundleItem> CatalogueInstaller::getBundles() const
{
    Catalogue snapshot;
    {
        const juce::ScopedLock lock (catalogueLock);
        snapshot = catalogue;
    }

    std::vector<BundleItem> bundles;
    bundles.reserve (snapshot.bundles.size());

    for (const auto& bundle : snapshot.bundles)
    {
        BundleItem item;
        item.bundle = bundle;

        const auto marker = bundleMarkerFile (bundle.id);
        if (marker.existsAsFile())
            item.installedVersion = juce::JSON::parse (marker.loadFileAsString())["version"].toString();

        // Derived from the package rows rather than stored: the bundle's own
        // record says which edition was installed, but what is actually on
        // disk is the packages' business, and a user may have removed one
        // individually since.
        //
        // Content counts exactly as a plugin does — a cab loader with no
        // impulses is as incomplete as a missing plugin, so "Install bundle" has
        // to cover both or it would silently leave the rig half-built. That
        // used to need a second loop; one list means it no longer does.
        for (const auto& packageId : bundle.packageIds)
        {
            const auto found = std::find_if (
                snapshot.packages.begin(), snapshot.packages.end(),
                [&packageId] (const CataloguePackage& p) { return p.id == packageId; });

            if (found == snapshot.packages.end())
                continue;

            const auto installedVersion = readInstalledVersion (markerIdFor (*found));

            if (installedVersion.isEmpty())
                item.missingPackageIds.add (packageId);
            else if (found->version != installedVersion)
                item.outdatedPackageIds.add (packageId);
        }

        bundles.push_back (std::move (item));
    }

    return bundles;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

bool CatalogueInstaller::installAsync (const juce::StringArray& ids,
                                         std::function<void (Progress)> onProgress,
                                         std::function<void (Result)> onFinished)
{
    if (running.exchange (true))
        return false;

    cancelRequested = false;

    std::vector<Installable> selected;
    {
        const juce::ScopedLock lock (catalogueLock);

        // Dependencies first, always: a patch naming the plugin it was built
        // for cannot be applied until that plugin is on disk, and the user asked
        // for one thing rather than for a checklist. Expanded here rather than
        // in the UI so every caller gets the same answer, and deduplicated so
        // asking for a package and something that depends on it in one go does
        // not download it twice.
        const auto wanted = resolveInstallOrder (catalogue, ids);

        for (const auto& id : wanted)
        {
            for (const auto& package : catalogue.packages)
            {
                if (package.id != id)
                    continue;

                Installable item;
                item.id = package.id;
                item.markerId = markerIdFor (package);
                item.dependsOn = package.dependsOn;
                item.name = package.name;
                item.version = package.version;

                // The payload is platform-selected here and nowhere else: one
                // lookup of this build's slug in `assets`, with no platform
                // special-cased. A package with no payload for this build
                // stays in the run so its row reports the refusal.
                if (const auto asset = package.assetFor (catalogueRuntimePlatform))
                {
                    item.sha256 = asset->sha256;
                    item.assetUrl = asset->url;
                    item.include = asset->include;
                    item.downloadBytes = asset->downloadBytes;
                }
                else
                {
                    item.availableHere = false;
                }

                // The one place `kind` is acted on, and the only place a
                // catalogue entry can decide where its payload lands. A content
                // package unpacks flat into its own data folder; only a plugin
                // reaches the VST3 scan path, where it will be loaded as code.
                item.pluginSemantics = ! package.isContent();
                item.preserveStructure = package.isContent() && package.preserveStructure;
                item.targetDir = package.isContent() ? contentDirectory (package.installDir)
                                                     : installDirectory();

                selected.push_back (std::move (item));
            }
        }
    }

    pool.addJob ([this,
                  selected = std::move (selected),
                  onProgress = std::move (onProgress),
                  onFinished = std::move (onFinished)]
    {
        Result result;
        const auto count = static_cast<int> (selected.size());
        juce::StringArray failedPackageIds;

        for (int i = 0; i < count; ++i)
        {
            const auto& plugin = selected[static_cast<size_t> (i)];

            Progress progress;
            progress.id = plugin.id;
            progress.name = plugin.name;
            progress.index = i + 1;
            progress.count = count;
            progress.total = plugin.downloadBytes;

            if (cancelRequested)
            {
                result.cancelled = true;
                break;
            }

            InstallOutcome outcome;

            if (! plugin.availableHere)
            {
                outcome = { Stage::failed, "not available for this platform" };
            }
            else if (plugin.dependsOn.isNotEmpty()
                     && failedPackageIds.contains (plugin.dependsOn))
            {
                outcome = { Stage::failed,
                            "dependency '" + plugin.dependsOn + "' failed to install" };
            }
            else
            {
                outcome = installOne (plugin, onProgress, progress);
            }

            switch (outcome.stage)
            {
                case Stage::installed: result.installed.add (plugin.id); break;
                case Stage::skipped:   result.skipped.add (plugin.id); break;
                default:
                    result.failed.emplace_back (plugin.id, outcome.error);
                    failedPackageIds.addIfNotAlreadyThere (plugin.id);
                    break;
            }

            // One package failing does not abort unrelated selections. Its
            // dependants are reported failed without touching their payloads,
            // because installing them would violate the dependency invariant.
            progress.stage = outcome.stage;
            progress.error = outcome.error;
            if (onProgress)
                juce::MessageManager::callAsync ([onProgress, progress] { onProgress (progress); });
        }

        running = false;

        if (onFinished)
            juce::MessageManager::callAsync ([onFinished, result] { onFinished (result); });
    });

    return true;
}

bool CatalogueInstaller::uninstallAsync (const juce::StringArray& ids,
                                           std::function<void (Result)> onFinished)
{
    if (running.exchange (true))
        return false;

    // Resolve each catalogue id to the marker that records it, here rather than
    // in the job: content markers are prefixed, so looking one up by the bare
    // id would find nothing, report the package removed and leave every file on
    // disk. An id with no catalogue entry (one dropped since it was installed)
    // is tried both ways for the same reason.
    juce::StringArray markerIds;
    {
        const juce::ScopedLock lock (catalogueLock);

        for (const auto& id : ids)
        {
            const auto found = std::find_if (
                catalogue.packages.begin(), catalogue.packages.end(),
                [&id] (const CataloguePackage& p) { return p.id == id; });

            if (found != catalogue.packages.end())
                markerIds.add (markerIdFor (*found));
            else
                markerIds.add (markerFile ("content-" + id).existsAsFile() ? "content-" + id : id);
        }
    }

    pool.addJob ([this, ids, markerIds, onFinished = std::move (onFinished)]
    {
        Result result;

        for (int i = 0; i < ids.size(); ++i)
        {
            const auto& id = ids[i];
            const auto marker = markerFile (markerIds[i]);

            if (! marker.existsAsFile())
            {
                // Nothing recorded means nothing of ours to remove. Treat as
                // done rather than an error: the user asked for it gone, and
                // it is.
                result.removed.add (id);
                continue;
            }

            const auto record = juce::JSON::parse (marker.loadFileAsString());
            juce::String failure;

            // Where the files actually went. Content unpacks outside the plugin
            // directory, so assuming that directory here would look through an
            // empty folder, delete nothing, and still report success. Markers
            // written before `dir` existed fall back to it.
            const auto recordedDir = record["dir"].toString();
            const auto installDir = recordedDir.isNotEmpty() ? juce::File (recordedDir)
                                                             : installDirectory();

            if (recordedDir.isNotEmpty()
                && ! isApprovedInstallMarkerDirectory (
                    recordedDir, installDirectory(), contentRootDirectory(),
                    markerIds[i].startsWith ("content-")))
                failure = "the install record is damaged";

            const auto* files = record["files"].getArray();
            if (failure.isEmpty() && files == nullptr)
                failure = "the install record is damaged";

            const auto* fingerprints = record["fingerprints"].getArray();

            if (failure.isEmpty())
            {
                for (int f = 0; f < files->size(); ++f)
                {
                    const auto name = (*files)[f].toString();

                    // Delete only what we wrote, only where we wrote it. A
                    // corrupted or hand-edited marker removes nothing rather
                    // than reaching outside the directory Plectrify owns.
                    if (! isSafeInstalledFileName (name))
                    {
                        failure = "the install record is damaged";
                        break;
                    }

                    const auto target = installDir.getChildFile (name);
                    if (! target.exists())
                        continue;

                    // Only what we wrote, and — where the folder is shared with
                    // other installers — only while it is still what we wrote.
                    // See mayDeleteManagedPlugin(), which is where that rule
                    // and its per-OS half live. Records written before
                    // fingerprints (and content records, which carry none) are
                    // removed by name as they always were.
                    if (fingerprints != nullptr && f < fingerprints->size()
                        && ! mayDeleteManagedPlugin (
                            (*fingerprints)[f].toString(),
                            installedFileFingerprint (target),
                            PluginManager::managedPluginDirectoryIsExclusive))
                        continue;

                    const bool deleted = target.isDirectory() ? target.deleteRecursively()
                                                              : target.deleteFile();
                    if (! deleted)
                    {
                        failure = "locked";
                        break;
                    }
                }
            }

            if (failure.isNotEmpty())
            {
                result.failed.emplace_back (id, failure);
                continue;
            }

            // Last, so an interrupted uninstall leaves the marker behind and
            // the next attempt can finish the job rather than orphaning files
            // nothing records any more.
            marker.deleteFile();
            result.removed.add (id);
        }

        running = false;

        if (onFinished)
            juce::MessageManager::callAsync ([onFinished, result] { onFinished (result); });
    });

    return true;
}

CatalogueInstaller::InstallOutcome
CatalogueInstaller::installOne (const Installable& plugin,
                                  const std::function<void (Progress)>& onProgress,
                                  Progress& progress)
{
    const auto report = [&] (Stage stage, juce::int64 received = 0)
    {
        if (onProgress == nullptr)
            return;

        auto snapshot = progress;
        snapshot.stage = stage;
        snapshot.received = received;
        juce::MessageManager::callAsync ([onProgress, snapshot] { onProgress (snapshot); });
    };

    if (readInstalledVersion (plugin.markerId) == plugin.version)
        return { Stage::skipped, {} };

    const auto installDir = plugin.targetDir;

    // Content lands in the machine-wide root, which every account has to be
    // able to add to; a plugin's directory is per-user on both OSes and wants
    // no more than the umask that created it.
    if (plugin.pluginSemantics)
        installDir.createDirectory();
    else
        createSharedContentDirectory (installDir);

    const auto stagingRoot = installDirectory().getChildFile (".staging");
    const auto stagingDir = stagingRoot.getChildFile (plugin.id);
    stagingDir.deleteRecursively();
    stagingDir.createDirectory();

    const juce::ScopeGuard cleanUp { [&stagingDir, &stagingRoot]
    {
        stagingDir.deleteRecursively();
        stagingRoot.deleteFile(); // succeeds only when no other staging entry remains
    } };

    // --- download, hashing as we go so the bytes are read once -------------
    report (Stage::downloading);

    const auto archive = stagingDir.getChildFile ("asset.zip");

    {
        const auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                                 .withConnectionTimeoutMs (fetchTimeoutMs);

        auto stream = juce::URL (plugin.assetUrl).createInputStream (options);
        if (stream == nullptr)
            return { Stage::failed, "network" };

        juce::FileOutputStream out (archive);
        if (out.failedToOpen())
            return { Stage::failed, "couldn't write to the plugin folder" };

        const auto total = stream->getTotalLength();
        if (total > 0)
            progress.total = total;

        juce::HeapBlock<char> buffer (65536);
        juce::int64 received = 0;

        for (;;)
        {
            if (cancelRequested)
                return { Stage::failed, "cancelled" };

            const auto read = stream->read (buffer.getData(), 65536);
            if (read <= 0)
                break;

            out.write (buffer.getData(), static_cast<size_t> (read));
            received += read;
            report (Stage::downloading, received);
        }
    }

    // --- verify against the pinned hash before anything is unpacked -------
    report (Stage::verifying);

    {
        juce::FileInputStream in (archive);
        if (in.failedToOpen())
            return { Stage::failed, "couldn't read the download" };

        const juce::SHA256 digest (in);
        if (digest.toHexString().toLowerCase() != plugin.sha256)
            return { Stage::failed, "checksum" };
    }

    // --- extract ----------------------------------------------------------
    report (Stage::extracting);

    const auto extracted = stagingDir.getChildFile ("extracted");
    extracted.createDirectory();

    {
        juce::ZipFile zip (archive);

        for (int i = 0; i < zip.getNumEntries(); ++i)
        {
            if (cancelRequested)
                return { Stage::failed, "cancelled" };

            const auto* entry = zip.getEntry (i);
            if (entry == nullptr)
                continue;

            if (! isSafeArchiveEntryName (entry->filename))
                return { Stage::failed, "the archive contains an unsafe path" };

            if (! matchesAnyIncludePattern (entry->filename, plugin.include))
                continue;

            // A symlink's target is the entry's content, which the name check
            // above never sees; refuse links that could point outside what is
            // extracted beside them (macOS bundles legitimately carry relative
            // links, e.g. Foo.vst3/Contents/Frameworks).
            if (entry->isSymbolicLink)
            {
                std::unique_ptr<juce::InputStream> linkStream (zip.createStreamForEntry (i));
                if (linkStream == nullptr
                    || ! isSafeSymlinkTarget (linkStream->readEntireStreamAsString()))
                    return { Stage::failed, "the archive contains an unsafe path" };
            }

            if (! zip.uncompressEntry (i, extracted, true).wasOk())
                return { Stage::failed, "couldn't unpack the download" };

            // JUCE creates every extracted file 0644 and drops the archive's
            // Unix modes, so an executable entry has to be restored by hand —
            // a mac bundle whose Contents/MacOS binary lost +x is installed,
            // intact, and unloadable. Does nothing on Windows, where NTFS has
            // no execute bit and the archives carry no modes to read.
            if (archiveEntryIsExecutable (entry->externalFileAttributes))
                extracted.getChildFile (entry->filename).setExecutePermission (true);
        }
    }

    // --- move what was extracted into place -------------------------------
    report (Stage::installing);

    juce::StringArray installedFiles;

    if (! plugin.pluginSemantics)
    {
        // Content unpacks flat: an IR browser wants one folder of files, not
        // whatever directory nesting the upstream pack happened to use. These
        // are data files, never loaded as code, so none of the VST3 bundle
        // handling below applies.
        //
        // Unless the package keeps its structure, in which case each top-level
        // entry moves across whole — a patch and the assets it loads are one
        // folder, and pulling them apart would lose which belongs to which.
        // Either way what lands is recorded by its name in `installDir`, which
        // is what uninstall walks.
        const auto searchDepth = plugin.preserveStructure ? juce::File::findFilesAndDirectories
                                                          : juce::File::findFiles;
        for (const auto& source : extracted.findChildFiles (searchDepth, ! plugin.preserveStructure))
        {
            const auto target = installDir.getChildFile (source.getFileName());

            if (target.isDirectory() ? ! target.deleteRecursively() : ! target.deleteFile())
                return { Stage::failed, "couldn't replace what is already installed" };

            if (! source.moveFileTo (target))
                return { Stage::failed, "couldn't write to the content folder" };

            installedFiles.add (target.getFileName());
        }

        if (installedFiles.isEmpty())
            return { Stage::failed, "the download contained no files" };

        writeMarker (plugin, installedFiles, MarkerState::complete);
        return { Stage::installed, {} };
    }

    // A VST3 on Windows is usually a bundle directory; findChildFiles with
    // findFilesAndDirectories catches both that and a bare .vst3 file.
    const auto found = extracted.findChildFiles (
        juce::File::findFilesAndDirectories, true, "*.vst3");

    std::vector<juce::File> sources;

    for (const auto& source : found)
    {
        // Every bundle also contains a .vst3 DLL of the same name a few levels
        // down; only the outermost is the plugin.
        if (! isOutermostPluginPath (source.getRelativePathFrom (extracted)))
            continue;

        sources.push_back (source);
        installedFiles.add (source.getFileName());
    }

    if (installedFiles.isEmpty())
        return { Stage::failed, "the download contained no VST3 plugin" };

    // Which names in the load path Plectrify accounts for, and what they looked
    // like when it put them there. Read once: the markers do not change under
    // us, and this asks about each name it is about to write.
    const auto claims = installedPluginFileClaims();

    // Decided for every name before any of them is touched, so a package whose
    // second bundle is somebody else's plugin does not first replace the first
    // one and then refuse — a half-installed plugin is worse than a refused
    // one.
    for (const auto& source : sources)
    {
        const auto target = installDir.getChildFile (source.getFileName());

        if (looksLikeSharingViolation (target))
            return { Stage::failed, "locked" };

        if (! target.exists())
            continue;

        // Not every Foo.vst3 in this directory is necessarily a copy of ours to
        // replace — see mayReplaceManagedPlugin(), which is where the rule and
        // the reasoning live.
        const auto claim = claims.find (target.getFileName());

        if (! mayReplaceManagedPlugin (claim != claims.end(),
                                       claim != claims.end() ? claim->second : juce::String(),
                                       installedFileFingerprint (target),
                                       PluginManager::managedPluginDirectoryIsExclusive))
            return { Stage::failed, "another copy is already installed" };
    }

    // Claim the names before writing any of them, so an install interrupted
    // between the move and the record leaves something that accounts for what
    // is on disk. See MarkerState.
    writeMarker (plugin, installedFiles, MarkerState::pending);

    for (const auto& source : sources)
    {
        const auto target = installDir.getChildFile (source.getFileName());

        if (target.exists()
            && (target.isDirectory() ? ! target.deleteRecursively() : ! target.deleteFile()))
            return { Stage::failed, "locked" };

        if (! source.moveFileTo (target))
            return { Stage::failed, "locked" };
    }

    writeMarker (plugin, installedFiles, MarkerState::complete);
    return { Stage::installed, {} };
}
