#include "PluginManager.h"
#include "AppPaths.h"
#include "PluginBinary.h"

PluginManager::PluginManager() : juce::Thread ("Plectrify plugin scan")
{
    formatManager.addFormat (std::make_unique<juce::VST3PluginFormat>());

   #if JUCE_PLUGINHOST_VST
    // The VST2-era format (.dll / .vst / .so), compiled against the FST header
    // — see CMakeLists.txt for why that is possible and the rules that come
    // with it. JUCE's own class: the scan, the cache, the blacklist and
    // instantiation below know nothing format-specific, and a description's
    // identifier string embeds the format name, so a .dll and a .vst3 of the
    // same plugin are two entries that never stand in for each other.
    formatManager.addFormat (std::make_unique<juce::VSTPluginFormat>());
   #endif

    loadFromSettings();
    loadUserFolders();

    // Uninstalled plugins drop out of the picker at launch, not only after
    // the user happens to rescan.
    if (pruneMissingPlugins())
        saveToSettings();
}

PluginManager::~PluginManager()
{
    // A hostile plugin can hang its own load; after the grace period the scan
    // thread is force-killed rather than hanging app shutdown forever.
    stopThread (10000);
}

juce::File PluginManager::getManagedPluginDirectory()
{
   #if JUCE_MAC
    // The per-user VST3 convention. macOS has no ProgramData equivalent that
    // is both machine-wide and writable without admin rights (/Library is
    // admin-owned), so per-user is what preserves the no-elevation install
    // model — and other hosts still find the plugins here.
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile ("Library/Audio/Plug-Ins/VST3");
   #elif JUCE_LINUX
    // The per-user VST3 convention again, for the same reason: the
    // machine-wide /usr/lib/vst3 needs root, and every Linux host already
    // searches ~/.vst3.
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile (".vst3");
   #else
    return juce::File::getSpecialLocation (juce::File::commonApplicationDataDirectory)
        .getChildFile ("Plectrify")
        .getChildFile ("plugins");
   #endif
}

juce::File PluginManager::getBundledPluginDirectory()
{
   #if JUCE_DEBUG && defined (PLECTRIFY_BUNDLED_PLUGIN_DIR)
    // The dev loop's copy, if one has been staged there. Checked first so a
    // developer can test the shipped layout without building an installer.
    if (const juce::File fromSourceTree { PLECTRIFY_BUNDLED_PLUGIN_DIR }; fromSourceTree.isDirectory())
        return fromSourceTree;
   #endif

    // Under the same resource root the UI is served from (beside the exe on
    // Windows, Contents/Resources on macOS — inside the signature seal there),
    // resolved from the running module so a VST3 build finds its own copy.
    return plectrify::moduleResourceDir().getChildFile ("plugins");
}

juce::FileSearchPath PluginManager::getDefaultSearchPaths() const
{
    juce::FileSearchPath paths;

    for (auto* format : formatManager.getFormats())
        paths.addPath (format->getDefaultLocationsToSearch());

    // Catalogue plugins live here. Created up front because
    // PluginDirectoryScanner silently skips a path that doesn't exist, which
    // would make a first scan miss everything installed later in the session.
    const auto managed = getManagedPluginDirectory();
    managed.createDirectory();
    paths.addIfNotAlreadyThere (managed);

    // Not created if absent, unlike the managed directory: this one is part of
    // the installation, so its absence is a fact about the build (a Debug tree
    // with nothing staged) rather than something to fix by making a folder.
    if (const auto bundled = getBundledPluginDirectory(); bundled.isDirectory())
        paths.addIfNotAlreadyThere (bundled);

    loadUserFolders(); // another instance may have changed the list
    // The user's own folders. One that has gone (an unplugged drive) is simply
    // not there to scan; the list keeps it, since the drive may come back.
    for (const auto& folder : userFolders)
        if (juce::File (folder).isDirectory())
            paths.addIfNotAlreadyThere (folder);

    return paths;
}

juce::File PluginManager::getUserFoldersFile()
{
    return plectrify::appDataDir().getChildFile ("plugin_folders.json");
}

juce::StringArray PluginManager::getUserFolders() const
{
    loadUserFolders(); // shared with every other instance; see addUserFolder
    return userFolders;
}

bool PluginManager::addUserFolder (const juce::File& folder)
{
    // The file is shared with every other Plectrify on the machine (the
    // standalone and each DAW instance), so a change starts from what is on
    // disk now — a copy read at construction would write another instance's
    // additions straight back out of the list.
    loadUserFolders();

    if (! folder.isDirectory() || userFolders.contains (folder.getFullPathName()))
        return false;

    userFolders.add (folder.getFullPathName());
    saveUserFolders();
    return true;
}

bool PluginManager::removeUserFolder (const juce::File& folder)
{
    if (isScanning())
        return false;

    loadUserFolders(); // see addUserFolder

    if (! userFolders.contains (folder.getFullPathName()))
        return false;

    userFolders.removeString (folder.getFullPathName());
    saveUserFolders();

    // Forget what was found there — but only what is no longer searched at
    // all. A folder inside a default location, or nested in another user
    // folder, is still walked by the next scan, and dropping its plugins
    // would empty them out of the drawer (and show every rack using them as
    // not installed) until a full Rescan happened to bring them back.
    const auto forget = [&] (const juce::String& path, const juce::String& formatName)
    {
        return juce::File::createFileWithoutCheckingPath (path).isAChildOf (folder)
            && ! isStillSearched (path, formatName);
    };

    bool listChanged = false;
    for (const auto& type : knownPlugins.getTypes())
    {
        if (forget (type.fileOrIdentifier, type.pluginFormatName))
        {
            knownPlugins.removeType (type);
            listChanged = true;
        }
    }
    for (const auto& blacklisted : knownPlugins.getBlacklistedFiles()) // copy; the loop mutates the list
    {
        if (forget (blacklisted, {}))
        {
            knownPlugins.removeFromBlacklist (blacklisted);
            listChanged = true;
        }
    }
    {
        const juce::ScopedLock lock (unloadableLock);
        for (int i = unloadable.size(); --i >= 0;)
        {
            if (forget (unloadable.getReference (i).path, {}))
            {
                unloadable.remove (i);
                listChanged = true;
            }
        }
    }

    if (listChanged)
        saveToSettings();

    return true;
}

void PluginManager::loadUserFolders() const
{
    userFolders.clear();

    const auto file = getUserFoldersFile();
    if (! file.existsAsFile())
        return;

    // A plain JSON array of absolute paths. Anything else in the file is
    // ignored rather than fatal: this is a convenience list, not a document.
    // The parsed var is held by name: getArray() points into it, and on a
    // temporary that pointer dangles before the loop reads it.
    const auto parsed = juce::JSON::parse (file);
    if (auto* list = parsed.getArray())
        for (const auto& entry : *list)
            if (entry.isString() && juce::File::isAbsolutePath (entry.toString()))
                userFolders.addIfNotAlreadyThere (entry.toString());
}

void PluginManager::saveUserFolders() const
{
    juce::Array<juce::var> list;
    for (const auto& folder : userFolders)
        list.add (folder);

    const auto file = getUserFoldersFile();
    file.getParentDirectory().createDirectory();
    file.replaceWithText (juce::JSON::toString (juce::var (list)));
}

bool PluginManager::scanAndAddPluginsAsync (const juce::FileSearchPath& paths,
                                            std::function<void (bool listChanged)> onPluginScanned,
                                            std::function<void()> onFinished)
{
    if (scanning.exchange (true))
        return false;

    // The previous run() may still be unwinding its final statements even
    // though `scanning` already reads false; a fresh start needs a dead thread.
    waitForThreadToExit (-1);

    pathsToScan = paths;
    pathsToScan.removeRedundantPaths();

    // Decided here, on the message thread, because it reads userFolders; the
    // scan thread only walks what it is handed.
    formatPathsToScan.clear();
    for (auto* format : formatManager.getFormats())
        formatPathsToScan.push_back (pathsForFormat (*format, pathsToScan));

    pluginScannedCallback = std::move (onPluginScanned);
    finishedCallback = std::move (onFinished);
    startThread();
    return true;
}

void PluginManager::run()
{
    // Scanning instantiates every plugin in this process, so a crashing VST3
    // takes the whole app down mid-scan. The dead-man's-pedal file names the
    // plugin about to be scanned; if a previous scan died, blacklist that file
    // so this scan skips it instead of crashing the same way every time.
    const auto pedal = getCacheFile().getSiblingFile ("scan_in_progress.txt");
    pedal.getParentDirectory().createDirectory(); // a first-ever scan precedes any cache write
    juce::PluginDirectoryScanner::applyBlacklistingsFromDeadMansPedal (knownPlugins, pedal);
    pedal.deleteFile();

    pruneMissingPlugins();
    pruneFilesInsideBundles();

    auto lastCount = knownPlugins.getNumTypes();

    // Each format's files are listed once and that one list serves both the
    // scanner and recordUnloadablePlugins. The scanner is built over an empty
    // path because its constructor walks whatever it is given, and that walk
    // would only be thrown away by setFilesOrIdentifiersToScan.
    const auto formats = formatManager.getFormats();
    std::vector<juce::StringArray> scannedFiles (formats.size());

    for (int f = 0; f < formats.size() && ! threadShouldExit(); ++f)
    {
        auto* format = formats[f];
        scannedFiles[(size_t) f] = filesToScan (*format, formatPathsToScan[(size_t) f]);

        juce::PluginDirectoryScanner scanner (knownPlugins, *format, juce::FileSearchPath(),
                                              /*recursive*/ true,
                                              pedal,
                                              /*allowAsync*/ false);
        scanner.setFilesOrIdentifiersToScan (scannedFiles[(size_t) f]);

        juce::String pluginBeingScanned;
        // Persist whenever a file adds plugins, so those found before a
        // mid-scan crash survive it — but not for files skipped as already
        // known, or an unchanged rescan rewrites the whole cache per file.
        // The cache XML also carries the blacklist.
        while (! threadShouldExit()
               && scanner.scanNextFile (/*dontRescanIfAlreadyInList*/ true, pluginBeingScanned))
        {
            const auto count = knownPlugins.getNumTypes();
            const bool listChanged = count != lastCount;
            lastCount = count;

            if (listChanged)
                saveToSettings();
            if (pluginScannedCallback != nullptr)
                pluginScannedCallback (listChanged);
        }
    }

    if (! threadShouldExit())
        recordUnloadablePlugins (scannedFiles);

    saveToSettings();
    scanning.store (false); // before the callback, so a finish-triggered rescan can start
    if (finishedCallback != nullptr)
        finishedCallback();
}

bool PluginManager::isInsideAnotherFormatsBundle (const juce::String& path)
{
    // Walk the parents, not the file itself: the format's own bundle (a .vst
    // on macOS) is fine, a binary *inside* some other format's bundle is not.
    for (auto dir = juce::File::createFileWithoutCheckingPath (path).getParentDirectory();
         dir.getFullPathName().isNotEmpty() && dir != dir.getParentDirectory();
         dir = dir.getParentDirectory())
    {
        if (dir.hasFileExtension (".vst3") || dir.hasFileExtension (".component"))
            return true;
    }
    return false;
}

juce::FileSearchPath PluginManager::ownLocations (juce::AudioPluginFormat& format) const
{
    auto own = format.getDefaultLocationsToSearch();

    if (format.getName() == "VST3")
    {
        own.addIfNotAlreadyThere (getManagedPluginDirectory());
        if (const auto bundled = getBundledPluginDirectory(); bundled.isDirectory())
            own.addIfNotAlreadyThere (bundled);
    }

    // The user named these without saying which format lives there — that is
    // the point of adding a folder — so every format searches them.
    for (const auto& folder : userFolders)
        own.addIfNotAlreadyThere (juce::File (folder));

    return own;
}

juce::FileSearchPath PluginManager::pathsForFormat (juce::AudioPluginFormat& format,
                                                    const juce::FileSearchPath& paths) const
{
    const auto own = ownLocations (format);
    juce::FileSearchPath result;

    for (int p = 0; p < paths.getNumPaths(); ++p)
    {
        const auto path = paths[p];
        bool covered = false;

        for (int o = 0; o < own.getNumPaths() && ! covered; ++o)
            covered = path == own[o] || path.isAChildOf (own[o]);

        if (covered)
        {
            result.addIfNotAlreadyThere (path);
            continue;
        }

        // A path wider than any of this format's locations: walk only the
        // locations inside it, not the rest of it.
        for (int o = 0; o < own.getNumPaths(); ++o)
            if (own[o].isAChildOf (path))
                result.addIfNotAlreadyThere (own[o]);
    }

    result.removeRedundantPaths();
    return result;
}

bool PluginManager::isStillSearched (const juce::String& path, const juce::String& formatName) const
{
    const auto file = juce::File::createFileWithoutCheckingPath (path);

    for (auto* format : formatManager.getFormats())
    {
        if (formatName.isNotEmpty() && format->getName() != formatName)
            continue;

        const auto own = ownLocations (*format);
        for (int o = 0; o < own.getNumPaths(); ++o)
            if (file == own[o] || file.isAChildOf (own[o]))
                return true;
    }
    return false;
}

juce::StringArray PluginManager::filesToScan (juce::AudioPluginFormat& format,
                                              const juce::FileSearchPath& paths) const
{
    auto files = format.searchPathsForPlugins (paths, /*recursive*/ true, /*allowAsync*/ false);
    files.removeDuplicates (/*ignoreCase*/ false);

    // The older format's search is recursive and takes every .so (.dll) it
    // finds, so on Linux it descended into each VST3 bundle and offered the
    // VST3's own binary as a plugin of its kind — loading it a second time,
    // under another format's entry point. The bundled NAM inside an installed
    // Plectrify.vst3 is what crashed a scan and landed on the blacklist. A
    // binary inside a .vst3 (or AU .component) bundle belongs to that bundle.
    if (format.getName() != "VST3")
        for (int i = files.size(); --i >= 0;)
            if (isInsideAnotherFormatsBundle (files[i]))
                files.remove (i);

    return files;
}

void PluginManager::pruneFilesInsideBundles()
{
    // What scans before that rule left behind: known types and blacklist
    // entries of the older format that name a binary inside a bundle.
    for (const auto& type : knownPlugins.getTypes())
        if (type.pluginFormatName != "VST3" && isInsideAnotherFormatsBundle (type.fileOrIdentifier))
            knownPlugins.removeType (type);

    for (const auto& blacklisted : knownPlugins.getBlacklistedFiles())
        if (! blacklisted.endsWithIgnoreCase (".vst3") && isInsideAnotherFormatsBundle (blacklisted))
            knownPlugins.removeFromBlacklist (blacklisted);
}

juce::StringArray PluginManager::getBlacklistedPlugins() const
{
    return knownPlugins.getBlacklistedFiles();
}

juce::Array<PluginManager::UnloadablePlugin> PluginManager::getUnloadablePlugins() const
{
    const juce::ScopedLock lock (unloadableLock);
    return unloadable;
}

void PluginManager::recordUnloadablePlugins (const std::vector<juce::StringArray>& scannedFiles)
{
    // The very lists the scanners were given, so this sees exactly the files they saw:
    // the format's own filter decides what counts as a plugin file (.vst3
    // bundles; .dll / .vst / .so for the older format), and anything that
    // filter admitted but the known list does not hold was found and not
    // loaded. The blacklist is the other reason a file yields no type, and
    // has its own row.
    juce::Array<UnloadablePlugin> fresh;
    const auto blacklist = knownPlugins.getBlacklistedFiles();

    juce::StringArray seen; // one row per file, whichever format listed it

    for (const auto& files : scannedFiles)
    {
        for (const auto& id : files)
        {
            if (threadShouldExit())
                return;
            if (blacklist.contains (id) || knownPlugins.getTypeForFile (id) != nullptr || seen.contains (id))
                continue;
            seen.add (id);

            const auto reason = plectrify::pluginbinary::whyUnloadable (juce::File (id));
            if (reason.isNotEmpty())
                fresh.add ({ id, reason });
        }
    }

    const juce::ScopedLock lock (unloadableLock);

    // Entries under the folders this scan covered are replaced wholesale — a
    // file since fixed or removed drops out. A narrow scan (one folder) leaves
    // the rest standing, exactly as it leaves the rest of the known list.
    for (int i = unloadable.size(); --i >= 0;)
    {
        const auto file = juce::File::createFileWithoutCheckingPath (unloadable.getReference (i).path);
        for (int d = 0; d < pathsToScan.getNumPaths(); ++d)
        {
            if (file.isAChildOf (pathsToScan[d]))
            {
                unloadable.remove (i);
                break;
            }
        }
    }
    unloadable.addArray (fresh);
}

int PluginManager::unblacklistPlugins (const juce::StringArray& files)
{
    if (isScanning())
        return 0;

    const auto blacklist = knownPlugins.getBlacklistedFiles(); // copy; the loop mutates the list
    int removed = 0;

    for (const auto& blacklisted : blacklist)
    {
        if (files.isEmpty() || files.contains (blacklisted))
        {
            knownPlugins.removeFromBlacklist (blacklisted);
            ++removed;
        }
    }

    if (removed > 0)
        saveToSettings();

    return removed;
}

namespace
{
    /** `Foo.vst3/Contents/<arch>-linux/Foo.so` → `Foo.vst3`; anything else
        unchanged. Matched on the path's shape alone, so it is harmless on
        every OS and also repairs a Linux document opened elsewhere (where the
        bundle path then misses and the uid fallback takes over). */
    juce::String bundlePathForModule (const juce::String& fileOrIdentifier)
    {
        const auto module = juce::File::createFileWithoutCheckingPath (fileOrIdentifier);
        const auto archDir = module.getParentDirectory();
        const auto contents = archDir.getParentDirectory();
        const auto bundle = contents.getParentDirectory();

        if (module.hasFileExtension (".so")
            && archDir.getFileName().endsWith ("-linux")
            && contents.getFileName() == "Contents"
            && bundle.hasFileExtension (".vst3"))
            return bundle.getFullPathName();

        return fileOrIdentifier;
    }
}

juce::PluginDescription PluginManager::describeInstance (const juce::AudioPluginInstance& instance)
{
    auto desc = instance.getPluginDescription();
    desc.fileOrIdentifier = bundlePathForModule (desc.fileOrIdentifier);
    return desc;
}

void PluginManager::createInstanceAsync (
    const juce::PluginDescription& desc,
    double sampleRate,
    int blockSize,
    std::function<void (std::unique_ptr<juce::AudioPluginInstance>, const juce::String&)> callback)
{
    // A description out of a saved document (rig, working rack, host-saved
    // state) bakes the absolute path the plugin was loaded from, and that path
    // can rot while the plugin itself is still on the machine: the bundled
    // plugin lives at a different path per build (installed app, dev tree,
    // plugin bundle), and an uninstall or reinstall moves it. JUCE answers a
    // dead path with the misleading "no compatible plug-in format exists", so
    // when the named file is gone, fall back to the scan cache's entry for the
    // same plugin — matched by format and uid, never by path (deliberately not
    // matchesIdentifierString, which hashes the file path into the identity:
    // the moved path is exactly the part that must not count). Only a live
    // file is substituted: the cache prunes at scan time, not continuously.
    // The next capture writes the loaded instance's real path, so the document
    // heals itself on the following save.
    auto resolved = desc;
    resolved.fileOrIdentifier = bundlePathForModule (desc.fileOrIdentifier);
    if (! juce::File::createFileWithoutCheckingPath (resolved.fileOrIdentifier).exists())
    {
        const auto sameId = [] (int known, int stored) { return stored != 0 && known == stored; };
        for (const auto& known : knownPlugins.getTypes())
        {
            if (known.pluginFormatName == desc.pluginFormatName
                && (sameId (known.uniqueId, desc.uniqueId)
                    || sameId (known.deprecatedUid, desc.deprecatedUid))
                && juce::File::createFileWithoutCheckingPath (known.fileOrIdentifier).exists())
            {
                resolved = known;
                break;
            }
        }
    }

    formatManager.createPluginInstanceAsync (
        resolved, sampleRate, blockSize,
        [cb = std::move (callback)] (std::unique_ptr<juce::AudioPluginInstance> instance,
                                     const juce::String& error)
        {
            cb (std::move (instance), error);
        });
}

juce::File PluginManager::getCacheFile() const
{
    return plectrify::appDataDir().getChildFile ("known_plugins.xml");
}

void PluginManager::saveToSettings()
{
    if (auto xml = knownPlugins.createXml())
    {
        {
            // Beside JUCE's PLUGIN and BLACKLISTED children, in a tag its
            // reader ignores (recreateFromXml skips what loadFromXml rejects).
            const juce::ScopedLock lock (unloadableLock);
            for (const auto& entry : unloadable)
            {
                auto* e = xml->createNewChildElement ("UNLOADABLE");
                e->setAttribute ("path", entry.path);
                e->setAttribute ("reason", entry.reason);
            }
        }

        auto file = getCacheFile();
        file.getParentDirectory().createDirectory();

        // Through a sibling temp file and an atomic swap: the standalone and a
        // DAW-hosted plugin instance share this cache across processes, and a
        // plain write interleaving with another's could leave it torn. Last
        // writer wins, which is the accepted trade for a rebuildable cache.
        const auto temporary = file.getSiblingFile (file.getFileName() + ".tmp");
        temporary.deleteFile();
        if (xml->writeTo (temporary))
        {
            if (file.existsAsFile())
                temporary.replaceFileIn (file);
            else
                temporary.moveFileTo (file);
        }
    }
}

void PluginManager::loadFromSettings()
{
    auto file = getCacheFile();
    if (! file.existsAsFile())
        return;

    if (auto xml = juce::XmlDocument::parse (file))
    {
        knownPlugins.recreateFromXml (*xml);

        const juce::ScopedLock lock (unloadableLock);
        unloadable.clear();
        for (auto* e : xml->getChildWithTagNameIterator ("UNLOADABLE"))
            if (e->getStringAttribute ("path").isNotEmpty() && e->getStringAttribute ("reason").isNotEmpty())
                unloadable.add ({ e->getStringAttribute ("path"), e->getStringAttribute ("reason") });
    }
}

bool PluginManager::pruneMissingPlugins()
{
    bool removedAny = false;

    // exists(), not existsAsFile(): a VST3 bundle can be a directory.
    for (const auto& type : knownPlugins.getTypes()) // getTypes() returns a copy
    {
        if (juce::File::isAbsolutePath (type.fileOrIdentifier)
            && ! juce::File (type.fileOrIdentifier).exists())
        {
            knownPlugins.removeType (type);
            removedAny = true;
        }
    }

    const auto blacklist = knownPlugins.getBlacklistedFiles(); // copy; the loop mutates the list
    for (const auto& blacklisted : blacklist)
    {
        if (juce::File::isAbsolutePath (blacklisted)
            && ! juce::File (blacklisted).exists())
        {
            knownPlugins.removeFromBlacklist (blacklisted);
            removedAny = true;
        }
    }

    {
        const juce::ScopedLock lock (unloadableLock);
        for (int i = unloadable.size(); --i >= 0;)
        {
            const auto& path = unloadable.getReference (i).path;
            if (juce::File::isAbsolutePath (path) && ! juce::File (path).exists())
            {
                unloadable.remove (i);
                removedAny = true;
            }
        }
    }

    return removedAny;
}
