#include "PluginManager.h"
#include "AppPaths.h"

PluginManager::PluginManager() : juce::Thread ("Plectrify plugin scan")
{
    formatManager.addFormat (std::make_unique<juce::VST3PluginFormat>());
    loadFromSettings();

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

    return paths;
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

    auto lastCount = knownPlugins.getNumTypes();

    for (auto* format : formatManager.getFormats())
    {
        juce::PluginDirectoryScanner scanner (knownPlugins, *format, pathsToScan,
                                              /*recursive*/ true,
                                              pedal,
                                              /*allowAsync*/ false);

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

    saveToSettings();
    scanning.store (false); // before the callback, so a finish-triggered rescan can start
    if (finishedCallback != nullptr)
        finishedCallback();
}

juce::StringArray PluginManager::getBlacklistedPlugins() const
{
    return knownPlugins.getBlacklistedFiles();
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

void PluginManager::createInstanceAsync (
    const juce::PluginDescription& desc,
    double sampleRate,
    int blockSize,
    std::function<void (std::unique_ptr<juce::AudioPluginInstance>, const juce::String&)> callback)
{
    formatManager.createPluginInstanceAsync (
        desc, sampleRate, blockSize,
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
        knownPlugins.recreateFromXml (*xml);
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

    return removedAny;
}
