#include "BackupArchive.h"

#include "Catalogue.h"

namespace plectrify::backup
{

namespace
{
    // The four sources, named rather than discovered. A backup must never grow
    // a file because one appeared in the data root — see the header.
    const char* const settingsFile = "settings.json";
    const char* const workingFile  = "working-rack.json";
    const char* const rigsDir      = "rigs";
    const char* const patchesDir   = "patches";

    // Written by the page around a session restore, and meaningless to another
    // machine: a stale sentinel quarantines the session it finds beside it.
    const char* const restoreSentinel   = "restore_in_progress";
    const char* const workingQuarantine = "working-rack.quarantine.json";

    /** Zip entries always use forward slashes, whatever wrote them. */
    juce::String entryNameFor (const juce::String& directory, const juce::String& fileName)
    {
        return directory + "/" + fileName;
    }

    /** One path segment, with none of the ways a name can mean something else
        to the filesystem: no separators, no dot-leading (hidden files, and the
        two relative names themselves), no empty string. */
    bool isPlainFileName (const juce::String& name)
    {
        return name.isNotEmpty()
            && ! name.startsWithChar ('.')
            && ! name.containsChar ('/')
            && ! name.containsChar ('\\');
    }

    /** Every file directly inside a data-root subfolder, sorted, so two runs
        over the same folder produce the same archive. */
    juce::Array<juce::File> filesIn (const juce::File& directory, const juce::String& pattern)
    {
        juce::Array<juce::File> found;

        if (directory.isDirectory())
            found = directory.findChildFiles (juce::File::findFiles, false, pattern);

        found.sort();
        return found;
    }
}

//==============================================================================
juce::String defaultBackupFileName (juce::Time now)
{
    return "Plectrify backup " + now.formatted ("%Y-%m-%d") + fileExtension;
}

bool isBackupEntryName (const juce::String& entryName)
{
    // The traversal, drive-letter and UNC gate CatalogueInstaller already puts
    // over juce::ZipFile. Everything below narrows within what it allows.
    if (! isSafeArchiveEntryName (entryName))
        return false;

    // A directory entry writes nothing this format needs, so it is not part of
    // it — the two folders arrive as a side effect of the files inside them.
    if (entryName.endsWithChar ('/') || entryName.endsWithChar ('\\'))
        return false;

    const auto normalised = entryName.replaceCharacter ('\\', '/');

    if (normalised == manifestEntryName || normalised == settingsFile || normalised == workingFile)
        return true;

    const auto slash = normalised.indexOfChar ('/');
    if (slash < 0)
        return false;

    const auto directory = normalised.substring (0, slash);
    const auto fileName  = normalised.substring (slash + 1);

    if (directory != rigsDir && directory != patchesDir)
        return false;

    return isPlainFileName (fileName);
}

juce::var buildManifest (int rigs, int patches, const juce::String& appVersion, juce::Time now)
{
    auto* document = new juce::DynamicObject();
    document->setProperty ("format", formatName);
    document->setProperty ("formatVersion", formatVersion);
    document->setProperty ("appVersion", appVersion);
    document->setProperty ("platform", catalogueRuntimePlatform);
    document->setProperty ("createdAt", now.toISO8601 (true));

    auto* counts = new juce::DynamicObject();
    counts->setProperty ("rigs", rigs);
    counts->setProperty ("patches", patches);
    document->setProperty ("counts", juce::var (counts));

    return juce::var (document);
}

bool parseManifest (const juce::var& document, Manifest& out)
{
    if (document.getDynamicObject() == nullptr)
        return false;

    if (document["format"].toString() != formatName)
        return false;

    // Not a range check but a ceiling: a version below this build's is a shape
    // it still understands, one above it is not.
    const int version = (int) document["formatVersion"];
    if (version <= 0 || version > formatVersion)
        return false;

    out.formatVersion = version;
    out.appVersion    = document["appVersion"].toString();
    out.platform      = document["platform"].toString();
    out.createdAt     = document["createdAt"].toString();

    const auto counts = document["counts"];
    out.rigs    = (int) counts["rigs"];
    out.patches = (int) counts["patches"];
    return true;
}

//==============================================================================
Result writeArchive (const juce::File& destination, const juce::File& dataRoot,
                     const juce::String& appVersion)
{
    Result result;
    result.path = destination;

    const auto rigFiles   = filesIn (dataRoot.getChildFile (rigsDir), "*.rig");
    const auto rigIndex   = dataRoot.getChildFile (rigsDir).getChildFile ("index.json");
    const auto patchFiles = filesIn (dataRoot.getChildFile (patchesDir), "*.patch");
    const auto settings   = dataRoot.getChildFile (settingsFile);
    const auto working    = dataRoot.getChildFile (workingFile);

    result.rigs     = rigFiles.size();
    result.patches  = patchFiles.size();
    result.platform = catalogueRuntimePlatform;

    if (result.rigs == 0 && result.patches == 0
        && ! settings.existsAsFile() && ! working.existsAsFile())
    {
        result.error = "empty";
        return result;
    }

    juce::ZipFile::Builder builder;

    const auto now = juce::Time::getCurrentTime();
    const auto manifest = juce::JSON::toString (
        buildManifest (result.rigs, result.patches, appVersion, now));

    // keepInternalCopyOfData: the builder reads its streams when writeToStream
    // runs, long after this String has gone.
    builder.addEntry (std::make_unique<juce::MemoryInputStream> (
                          manifest.toRawUTF8(), (size_t) manifest.getNumBytesAsUTF8(), true),
                      9, manifestEntryName, now);

    if (settings.existsAsFile()) builder.addFile (settings, 9, settingsFile);
    if (working.existsAsFile())  builder.addFile (working, 9, workingFile);
    if (rigIndex.existsAsFile()) builder.addFile (rigIndex, 9, entryNameFor (rigsDir, "index.json"));

    for (const auto& rig : rigFiles)
        builder.addFile (rig, 9, entryNameFor (rigsDir, rig.getFileName()));

    for (const auto& patch : patchFiles)
        builder.addFile (patch, 9, entryNameFor (patchesDir, patch.getFileName()));

    // Through a temporary, so a full disk or a failed write never leaves a
    // truncated archive at a path the user will later trust.
    juce::TemporaryFile temporary (destination);

    {
        juce::FileOutputStream out (temporary.getFile());

        if (out.failedToOpen() || ! builder.writeToStream (out, nullptr))
        {
            result.error = "write";
            return result;
        }
    }

    if (! temporary.overwriteTargetFileWithTemporary())
    {
        result.error = "save";
        return result;
    }

    result.ok = true;
    return result;
}

Result readArchive (const juce::File& source, const juce::File& dataRoot)
{
    Result result;
    result.path = source;

    juce::ZipFile zip (source);

    // Read and accept the manifest before deleting anything: a file that is
    // not one of ours, or is one a newer build wrote, must cost the user
    // nothing at all.
    const auto* manifestEntry = zip.getEntry (juce::String (manifestEntryName));

    if (manifestEntry == nullptr)
    {
        result.error = "notBackup";
        return result;
    }

    Manifest manifest;

    {
        const std::unique_ptr<juce::InputStream> stream (zip.createStreamForEntry (*manifestEntry));

        if (stream == nullptr
            || ! parseManifest (juce::JSON::parse (stream->readEntireStreamAsString()), manifest))
        {
            result.error = "newerFormat";
            return result;
        }
    }

    result.platform = manifest.platform;

    if (! dataRoot.createDirectory())
    {
        result.error = "dataRoot";
        return result;
    }

    dataRoot.getChildFile (rigsDir).deleteRecursively();
    dataRoot.getChildFile (patchesDir).deleteRecursively();
    dataRoot.getChildFile (settingsFile).deleteFile();
    dataRoot.getChildFile (workingFile).deleteFile();
    dataRoot.getChildFile (restoreSentinel).deleteFile();
    dataRoot.getChildFile (workingQuarantine).deleteFile();

    for (int i = 0; i < zip.getNumEntries(); ++i)
    {
        const auto* entry = zip.getEntry (i);

        if (entry == nullptr || entry->isSymbolicLink || ! isBackupEntryName (entry->filename))
            continue;

        const auto name = entry->filename.replaceCharacter ('\\', '/');

        if (name == manifestEntryName)
            continue;

        // FollowSymlinks::no: nothing this format writes is a link, and the
        // destination is the web page's own sandbox.
        if (! zip.uncompressEntry (i, dataRoot,
                                   juce::ZipFile::OverwriteFiles::yes,
                                   juce::ZipFile::FollowSymlinks::no)
                 .wasOk())
        {
            result.error = "damaged";
            return result;
        }

        if (name.endsWith (".rig"))   ++result.rigs;
        if (name.endsWith (".patch")) ++result.patches;
    }

    result.ok = true;
    return result;
}

} // namespace plectrify::backup
