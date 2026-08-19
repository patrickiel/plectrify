#include <JuceHeader.h>

#include "BackupArchive.h"

#include <iostream>

// Offline coverage for backup and restore. Two things are worth testing here
// and both are about damage: which zip entries a restore will write into the
// data root — the destination is the web page's file sandbox, so an entry named
// tone3000/credentials.json or audio_settings.xml must not land — and whether a
// round trip through a real archive preserves exactly the files the format
// claims and removes exactly the ones it replaces.

namespace
{
int failures = 0;

void check (bool condition, const juce::String& what)
{
    if (! condition)
    {
        ++failures;
        std::cerr << "FAIL " << what << "\n";
    }
}

/** A scratch directory that removes itself, so a failing assertion cannot leave
    a tree behind for the next run to trip over. */
struct ScratchDir
{
    explicit ScratchDir (const juce::String& name)
        : dir (juce::File::getSpecialLocation (juce::File::tempDirectory)
                   .getChildFile ("PlectrifyBackupTests")
                   .getChildFile (name))
    {
        dir.deleteRecursively();
        dir.createDirectory();
    }

    ~ScratchDir() { dir.deleteRecursively(); }

    juce::File dir;
};

void write (const juce::File& file, const juce::String& text)
{
    file.getParentDirectory().createDirectory();
    file.replaceWithText (text);
}

//==============================================================================
void testDefaultFileName()
{
    const juce::Time when (2026, 7, 19, 21, 34); // month is 0-based: August
    const auto name = plectrify::backup::defaultBackupFileName (when);

    check (name == "Plectrify backup 2026-08-19.plectrifybackup",
           "the default file name is dated and carries the extension");
    check (juce::File::createLegalFileName (name) == name,
           "the default file name needs no sanitising");
}

void testEntryAllowList()
{
    using plectrify::backup::isBackupEntryName;

    check (isBackupEntryName ("plectrify-backup.json"), "the manifest is allowed");
    check (isBackupEntryName ("settings.json"), "settings.json is allowed");
    check (isBackupEntryName ("working-rack.json"), "the working session is allowed");
    check (isBackupEntryName ("rigs/index.json"), "the rig index is allowed");
    check (isBackupEntryName ("rigs/blues-rig-e34bddf7.rig"), "a rig file is allowed");
    check (isBackupEntryName ("patches/patch-00d42dc8.patch"), "a patch file is allowed");

    // Traversal and absolute paths, which isSafeArchiveEntryName owns.
    check (! isBackupEntryName ("../settings.json"), "a parent escape is refused");
    check (! isBackupEntryName ("rigs/../../settings.json"), "a nested escape is refused");
    check (! isBackupEntryName ("/etc/passwd"), "an absolute path is refused");
    check (! isBackupEntryName ("C:/Windows/system32/x.dll"), "a drive letter is refused");
    check (! isBackupEntryName ("//server/share/x"), "a UNC path is refused");

    // The narrowing this format adds on top. Each of these is a real file in
    // the data root that a backup must never carry back in.
    check (! isBackupEntryName ("tone3000/credentials.json"),
           "a TONE3000 credential entry is refused");
    check (! isBackupEntryName ("audio_settings.xml"),
           "another machine's audio device is refused");
    check (! isBackupEntryName ("known_plugins.xml"), "the scan cache is refused");
    check (! isBackupEntryName ("looper-sessions/index.json"), "looper sessions are refused");
    check (! isBackupEntryName ("WebView2/Default/Cookies"), "a browser profile is refused");

    // Shape rules.
    check (! isBackupEntryName ("rigs/nested/deep.rig"), "a nested rig path is refused");
    check (! isBackupEntryName ("rigs/"), "a directory entry is refused");
    check (! isBackupEntryName ("rigs/.hidden"), "a dotfile inside rigs/ is refused");
    check (! isBackupEntryName ("rigs/."), "a bare dot inside rigs/ is refused");
    check (! isBackupEntryName ("rigs"), "the bare folder name is refused");
    check (! isBackupEntryName (""), "an empty name is refused");

    // Backslashes: a zip written on Windows by a careless tool. The allow-list
    // must read them as separators rather than as part of a file name, or
    // "rigs\\..\\..\\settings.json" would pass as one plain name.
    check (! isBackupEntryName ("rigs\\nested\\deep.rig"),
           "a backslash-separated nested path is refused");
}

void testManifest()
{
    using namespace plectrify::backup;

    const juce::Time when (2026, 7, 19, 21, 34);
    const auto document = buildManifest (3, 7, "1.2.3", when);

    Manifest manifest;
    check (parseManifest (document, manifest), "a manifest this build wrote parses");
    check (manifest.formatVersion == formatVersion, "the format version round-trips");
    check (manifest.rigs == 3 && manifest.patches == 7, "the counts round-trip");
    check (manifest.appVersion == "1.2.3", "the writing app version is recorded");
    check (manifest.platform.isNotEmpty(), "the writing platform is recorded");
    check (manifest.createdAt.startsWith ("2026-08-19"), "the creation time is recorded");

    // The version ceiling. A newer build's archive is refused whole rather than
    // half-restored — the same reasoning as the catalogue's schemaVersion gate.
    check (! parseManifest (juce::JSON::parse (R"({"format":"plectrify-backup","formatVersion":99})"),
                            manifest),
           "a newer format version is refused");
    check (! parseManifest (juce::JSON::parse (R"({"format":"plectrify-backup","formatVersion":0})"),
                            manifest),
           "a zero format version is refused");
    check (! parseManifest (juce::JSON::parse (R"({"format":"something-else","formatVersion":1})"),
                            manifest),
           "another format is refused");
    check (! parseManifest (juce::JSON::parse ("[]"), manifest), "a non-object is refused");
    check (! parseManifest (juce::var(), manifest), "a void document is refused");
}

//==============================================================================
void testRoundTrip()
{
    using namespace plectrify::backup;

    ScratchDir source ("source");
    ScratchDir target ("target");

    write (source.dir.getChildFile ("settings.json"), R"({"theme":"light"})");
    write (source.dir.getChildFile ("working-rack.json"), R"({"modules":[]})");
    write (source.dir.getChildFile ("rigs/index.json"), R"([{"id":"r1"}])");
    write (source.dir.getChildFile ("rigs/blues-r1.rig"), R"({"modules":["amp"]})");
    write (source.dir.getChildFile ("patches/patch-a.patch"), R"({"name":"Crunch"})");
    write (source.dir.getChildFile ("patches/patch-b.patch"), R"({"name":"Clean"})");

    // Present in the data root, and none of it the user's work.
    write (source.dir.getChildFile ("tone3000/credentials.json"), R"({"token":"secret"})");
    write (source.dir.getChildFile ("audio_settings.xml"), "<DEVICESETUP/>");
    write (source.dir.getChildFile ("known_plugins.xml"), "<KNOWNPLUGINS/>");
    write (source.dir.getChildFile ("looper-sessions/index.json"), "[]");

    const auto archive = source.dir.getParentDirectory().getChildFile ("round-trip.plectrifybackup");
    const juce::ScopeGuard cleanup { [&] { archive.deleteFile(); } };

    const auto written = writeArchive (archive, source.dir, "1.2.3");
    check (written.ok && written.error.isEmpty(), "writing an archive succeeds");
    check (written.rigs == 1 && written.patches == 2, "the write reports what it archived");
    check (archive.existsAsFile() && archive.getSize() > 0, "the archive is on disk");

    // Nothing outside the four sources may be in the archive at all — the
    // allow-list on the way back in is the second gate, not the only one.
    {
        juce::ZipFile zip (archive);
        for (int i = 0; i < zip.getNumEntries(); ++i)
        {
            const auto name = zip.getEntry (i)->filename;
            check (isBackupEntryName (name), "archived entry " + name + " is one this format writes");
        }
        check (zip.getEntry ("tone3000/credentials.json") == nullptr,
               "the TONE3000 credential is not in the archive");
        check (zip.getEntry ("audio_settings.xml") == nullptr,
               "the audio device state is not in the archive");
        check (zip.getEntry ("known_plugins.xml") == nullptr,
               "the scan cache is not in the archive");
    }

    // A destination with its own contents: what the format writes must be
    // replaced, and everything else left exactly alone.
    write (target.dir.getChildFile ("settings.json"), R"({"theme":"dark"})");
    write (target.dir.getChildFile ("rigs/stale-r9.rig"), R"({"modules":[]})");
    write (target.dir.getChildFile ("patches/patch-old.patch"), R"({"name":"Old"})");
    write (target.dir.getChildFile ("audio_settings.xml"), "<THISMACHINE/>");
    write (target.dir.getChildFile ("known_plugins.xml"), "<SCANNEDHERE/>");
    write (target.dir.getChildFile ("restore_in_progress"), "restoring");
    write (target.dir.getChildFile ("working-rack.quarantine.json"), "{}");

    const auto read = readArchive (archive, target.dir);
    check (read.ok && read.error.isEmpty(), "reading the archive succeeds");
    check (read.rigs == 1 && read.patches == 2, "the read reports what it restored");

    check (target.dir.getChildFile ("rigs/blues-r1.rig").loadFileAsString() == R"({"modules":["amp"]})",
           "a rig arrives with its contents");
    check (target.dir.getChildFile ("patches/patch-a.patch").existsAsFile()
               && target.dir.getChildFile ("patches/patch-b.patch").existsAsFile(),
           "both patches arrive");
    check (target.dir.getChildFile ("rigs/index.json").existsAsFile(), "the rig index arrives");
    check (target.dir.getChildFile ("settings.json").loadFileAsString() == R"({"theme":"light"})",
           "settings.json is replaced, not merged");
    check (target.dir.getChildFile ("working-rack.json").existsAsFile(),
           "the working session arrives");

    check (! target.dir.getChildFile ("rigs/stale-r9.rig").existsAsFile(),
           "a rig the archive does not carry is gone");
    check (! target.dir.getChildFile ("patches/patch-old.patch").existsAsFile(),
           "a patch the archive does not carry is gone");

    // A stale sentinel would quarantine the session that just arrived beside it.
    check (! target.dir.getChildFile ("restore_in_progress").existsAsFile(),
           "the session-restore sentinel is cleared");
    check (! target.dir.getChildFile ("working-rack.quarantine.json").existsAsFile(),
           "a previous quarantine is cleared");

    check (target.dir.getChildFile ("audio_settings.xml").loadFileAsString() == "<THISMACHINE/>",
           "this machine's audio device is left alone");
    check (target.dir.getChildFile ("known_plugins.xml").loadFileAsString() == "<SCANNEDHERE/>",
           "this machine's scan cache is left alone");
    check (! target.dir.getChildFile ("plectrify-backup.json").existsAsFile(),
           "the manifest is not unpacked into the data root");
    check (! target.dir.getChildFile ("tone3000").exists(),
           "no TONE3000 folder is created in the destination");
}

void testEmptyRootIsRefused()
{
    ScratchDir empty ("empty");

    const auto archive = empty.dir.getParentDirectory().getChildFile ("empty.plectrifybackup");
    const juce::ScopeGuard cleanup { [&] { archive.deleteFile(); } };

    const auto written = plectrify::backup::writeArchive (archive, empty.dir, "1.2.3");
    check (! written.ok && written.error.isNotEmpty(), "a data root with nothing in it is refused");
    check (! archive.existsAsFile(), "a refused backup writes no file");
}

void testBadArchivesCostNothing()
{
    using namespace plectrify::backup;

    ScratchDir target ("bad-target");
    write (target.dir.getChildFile ("settings.json"), R"({"theme":"dark"})");
    write (target.dir.getChildFile ("rigs/keep-me.rig"), R"({"modules":[]})");

    const auto survived = [&] (const juce::String& what)
    {
        check (target.dir.getChildFile ("settings.json").loadFileAsString() == R"({"theme":"dark"})"
                   && target.dir.getChildFile ("rigs/keep-me.rig").existsAsFile(),
               what);
    };

    // Not a zip at all.
    ScratchDir junk ("junk");
    const auto notAZip = junk.dir.getChildFile ("holiday.jpg");
    write (notAZip, "this is not a zip file");
    auto result = readArchive (notAZip, target.dir);
    check (! result.ok && result.error.isNotEmpty(), "a file that is not an archive is refused");
    survived ("a file that is not an archive leaves the data root untouched");

    // A file that does not exist.
    result = readArchive (junk.dir.getChildFile ("absent.plectrifybackup"), target.dir);
    check (! result.ok, "a missing file is refused");
    survived ("a missing file leaves the data root untouched");

    // A real zip carrying a manifest from a build that does not exist yet, plus
    // a rig — so a restore that ignored the version would visibly overwrite.
    const auto future = junk.dir.getChildFile ("future.plectrifybackup");
    {
        juce::ZipFile::Builder builder;
        const juce::String manifest (R"({"format":"plectrify-backup","formatVersion":99})");
        builder.addEntry (std::make_unique<juce::MemoryInputStream> (
                              manifest.toRawUTF8(), (size_t) manifest.getNumBytesAsUTF8(), true),
                          9, manifestEntryName, juce::Time::getCurrentTime());

        const juce::String rig (R"({"modules":["from-the-future"]})");
        builder.addEntry (std::make_unique<juce::MemoryInputStream> (
                              rig.toRawUTF8(), (size_t) rig.getNumBytesAsUTF8(), true),
                          9, "rigs/future.rig", juce::Time::getCurrentTime());

        juce::FileOutputStream out (future);
        builder.writeToStream (out, nullptr);
    }

    result = readArchive (future, target.dir);
    check (! result.ok && result.error.isNotEmpty(), "a newer format version is refused");
    survived ("a newer format version leaves the data root untouched");
    check (! target.dir.getChildFile ("rigs/future.rig").existsAsFile(),
           "nothing from a refused archive is unpacked");

    // A zip with no manifest — an ordinary zip someone renamed.
    const auto noManifest = junk.dir.getChildFile ("plain.plectrifybackup");
    {
        juce::ZipFile::Builder builder;
        const juce::String payload ("hello");
        builder.addEntry (std::make_unique<juce::MemoryInputStream> (
                              payload.toRawUTF8(), (size_t) payload.getNumBytesAsUTF8(), true),
                          9, "readme.txt", juce::Time::getCurrentTime());

        juce::FileOutputStream out (noManifest);
        builder.writeToStream (out, nullptr);
    }

    result = readArchive (noManifest, target.dir);
    check (! result.ok && result.error.isNotEmpty(), "an archive with no manifest is refused");
    survived ("an archive with no manifest leaves the data root untouched");
}

void testHostileArchiveIsFiltered()
{
    using namespace plectrify::backup;

    ScratchDir target ("hostile-target");
    ScratchDir junk ("hostile-junk");

    // A valid manifest, so the archive passes the gate and the per-entry
    // allow-list is what has to hold.
    const auto hostile = junk.dir.getChildFile ("hostile.plectrifybackup");
    {
        juce::ZipFile::Builder builder;
        const auto manifest = juce::JSON::toString (
            buildManifest (1, 0, "1.2.3", juce::Time::getCurrentTime()));
        builder.addEntry (std::make_unique<juce::MemoryInputStream> (
                              manifest.toRawUTF8(), (size_t) manifest.getNumBytesAsUTF8(), true),
                          9, manifestEntryName, juce::Time::getCurrentTime());

        const juce::String payload ("payload");
        for (const auto* name : { "tone3000/credentials.json",
                                  "audio_settings.xml",
                                  "known_plugins.xml",
                                  "rigs/nested/deep.rig" })
            builder.addEntry (std::make_unique<juce::MemoryInputStream> (
                                  payload.toRawUTF8(), (size_t) payload.getNumBytesAsUTF8(), true),
                              9, name, juce::Time::getCurrentTime());

        // The one legitimate entry, so the restore has something to succeed at.
        builder.addEntry (std::make_unique<juce::MemoryInputStream> (
                              payload.toRawUTF8(), (size_t) payload.getNumBytesAsUTF8(), true),
                          9, "rigs/good.rig", juce::Time::getCurrentTime());

        juce::FileOutputStream out (hostile);
        builder.writeToStream (out, nullptr);
    }

    const auto result = readArchive (hostile, target.dir);
    check (result.ok, "an archive with unwanted entries still restores its good ones");
    check (target.dir.getChildFile ("rigs/good.rig").existsAsFile(), "the allowed rig arrives");
    check (result.rigs == 1, "only the allowed rig is counted");

    check (! target.dir.getChildFile ("tone3000/credentials.json").existsAsFile(),
           "a credential entry is not written");
    check (! target.dir.getChildFile ("audio_settings.xml").existsAsFile(),
           "an audio-settings entry is not written");
    check (! target.dir.getChildFile ("known_plugins.xml").existsAsFile(),
           "a scan-cache entry is not written");
    check (! target.dir.getChildFile ("rigs/nested/deep.rig").existsAsFile(),
           "a nested rig entry is not written");
}
} // namespace

int main()
{
    testDefaultFileName();
    testEntryAllowList();
    testManifest();
    testRoundTrip();
    testEmptyRootIsRefused();
    testBadArchivesCostNothing();
    testHostileArchiveIsFiltered();

    juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getChildFile ("PlectrifyBackupTests")
        .deleteRecursively();

    if (failures != 0)
        return 1;

    std::cout << "Backup: all cases passed\n";
    return 0;
}
